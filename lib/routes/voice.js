// Voice mode for the Chat page: voices list, speech-to-text with tidying, and text-to-speech.
// The browser records the candidate (microphone, only while voice mode is on) and plays the replies.

import express from 'express';
import { q } from '../db.js';
import { requireUser } from '../auth.js';
import { config, OPENROUTER, requireKey, orHeaders, loadModels, pickModel, recordUsage } from '../openrouter.js';
import { buildVoiceTidyMessages } from '../prompt.js';
import { decisionsOn, voiceNeedsTidy } from '../decisions.js';
import { askDetectModel, addCost } from './ai.js';

export const router = express.Router();
router.use(requireUser);

const MAX_SPEAK_CHARS = 1200;
const pcmOnly = new Set(); // voice models that refused mp3: ask them for PCM straight away next time
const NEEDS_TIDY_MIN = 0.5;

// The user's voice: model from their prefs if it still exists, and a voice that model supports
async function chosenVoice(user) {
  const p = user.prefs || {};
  let tts = [];
  try { tts = (await loadModels()).tts; } catch { /* list unavailable: trust the saved choice */ }
  const model = (p.voiceModel && (!tts.length || tts.some((m) => m.id === p.voiceModel))) ? p.voiceModel : config.voiceModel;
  const info = tts.find((m) => m.id === model) || null;
  let voice = p.voiceModel === model && p.voiceName ? p.voiceName : model === config.voiceModel ? config.voiceName : '';
  if (info?.voices.length && !info.voices.includes(voice)) voice = info.voices.includes(config.voiceName) ? config.voiceName : info.voices[0];
  return { model, voice, info };
}

router.get('/voices', requireKey, async (req, res) => {
  try {
    const { tts } = await loadModels();
    const { model, voice } = await chosenVoice(req.user);
    res.json({ models: tts, defaults: { voiceModel: config.voiceModel, voiceName: config.voiceName }, current: { model, voice } });
  } catch (err) {
    res.status(502).json({ error: 'Could not load the voice list: ' + err.message });
  }
});

// The candidate's spoken turn (already transcribed piece by piece with /api/transcribe): fix misheard technical
// terms once, with the whole turn as context. With fast decisions on, Jev checks whether the text needs fixing
// and Haiku only runs when it does; with them off, Haiku always checks.
router.post('/voice/tidy', requireKey, async (req, res) => {
  const raw = String(req.body?.text || '').trim().slice(0, 6000);
  const context = String(req.body?.context || '').slice(0, 600);
  if (!raw) return res.json({ text: '', cost: null });
  const started = Date.now();
  let jev = null;
  let tidy = null;
  let text = raw;
  if (decisionsOn(req.user)) jev = await voiceNeedsTidy(req.user, raw, context);
  if (!jev || jev.p >= NEEDS_TIDY_MIN) {
    const model = await pickModel(req.user.prefs?.detectModel, config.detectModel, 'answer');
    if (!model.error) {
      try { tidy = await askDetectModel(req, model, buildVoiceTidyMessages(raw, context), 'chat_extra'); } catch (err) { console.error('[voice] tidy', err.message); }
    }
    const fixed = String(tidy?.content || '').trim().replace(/^"""|"""$/g, '').replace(/^["“]|["”]$/g, '').trim();
    // Keep the fix only if it is a plausible correction, not an answer or a rewrite
    if (fixed && fixed.length < raw.length * 1.6 + 20 && fixed.length > raw.length * 0.5) text = fixed;
  }
  const cost = addCost(jev?.cost, tidy?.cost);
  console.log(`[voice] turn ${raw.length} chars${jev ? ` jev(tidy=${jev.p.toFixed(2)})` : ''}${tidy ? ' +tidy' : ''}${text !== raw ? ' fixed' : ''} ${Date.now() - started}ms cost=${cost ?? '-'}`);
  res.json({ text, cost });
});

// Voice cost spoken before a reply is saved (the reply is still being written): added to that reply when it is saved
const pendingVoice = new Map();
export function takePendingVoiceCost(userId, chatId) {
  const key = `${userId}:${chatId}`;
  const v = pendingVoice.get(key) || 0;
  pendingVoice.delete(key);
  return v;
}

// 16-bit mono PCM -> WAV, for voice models that only return raw PCM (24 kHz per the OpenRouter docs)
function pcmToWav(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Text-to-speech for one chunk of a reply. Body: { text, chatId?, messageId? }. Returns audio (mp3, or wav for
// PCM-only models). The cost is estimated from the model's per-character price (the speech API returns audio, not
// a cost), counted under Chat, and added to the reply's cost: to messageId, or (reply not saved yet) to chatId's next reply.
router.post('/speak', requireKey, async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, MAX_SPEAK_CHARS);
  if (!text) return res.status(400).json({ error: 'Nothing to say.' });
  const { model, voice, info } = await chosenVoice(req.user);
  const call = (format) => fetch(`${OPENROUTER}/audio/speech`, {
    method: 'POST',
    headers: orHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model, input: text, ...(voice && { voice }), response_format: format }),
    signal: AbortSignal.timeout(30000),
  });
  try {
    let format = pcmOnly.has(model) ? 'pcm' : 'mp3';
    let r = await call(format);
    if (r.status === 400 && format === 'mp3') {
      // Some voice models only return PCM
      const err = await r.json().catch(() => ({}));
      if (!/pcm|format/i.test(err?.error?.message || '')) return res.status(400).json({ error: err?.error?.message || 'Voice request failed.' });
      pcmOnly.add(model);
      format = 'pcm';
      r = await call(format);
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('[speak]', r.status, err?.error?.message);
      return res.status(502).json({ error: err?.error?.message || `Voice failed (${r.status})` });
    }
    let audio = Buffer.from(await r.arrayBuffer());
    const pcm = format === 'pcm' || /pcm/i.test(r.headers.get('content-type') || '');
    if (pcm) audio = pcmToWav(audio);
    const cost = info?.perChar ? info.perChar * text.length : null;
    recordUsage(req.user.id, 'chat_extra', cost);
    const messageId = Number(req.body?.messageId);
    const chatId = Number(req.body?.chatId);
    if (cost && messageId > 0) {
      q(`update chat_messages m set cost = coalesce(m.cost, 0) + $2
           from chats c where m.id = $1 and m.chat_id = c.id and c.user_id = $3`, [messageId, cost, req.user.id])
        .catch((e) => console.error('[speak] cost', e.message));
    } else if (cost && chatId > 0) {
      const key = `${req.user.id}:${chatId}`;
      pendingVoice.set(key, (pendingVoice.get(key) || 0) + cost);
    }
    res.setHeader('Content-Type', pcm ? 'audio/wav' : 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (cost !== null) res.setHeader('X-Cost', String(cost));
    res.end(audio);
  } catch (err) {
    console.error('[speak] error', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Voice service error: ' + err.message });
  }
});
