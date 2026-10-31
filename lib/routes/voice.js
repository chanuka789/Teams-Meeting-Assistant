// Voice mode for the Chat page: voices list, speech-to-text for a spoken turn, and streamed text-to-speech.
// The browser records the candidate (microphone, only while voice mode is on) and plays the replies.

import express from 'express';
import { q } from '../db.js';
import { requireUser } from '../auth.js';
import { config, OPENROUTER, requireKey, orHeaders, loadModels, recordUsage } from '../openrouter.js';
import { speechToText, MAX_AUDIO_BASE64 } from './ai.js';

export const router = express.Router();
router.use(requireUser);

const MAX_SPEAK_CHARS = 1200;
const pcmOnly = new Set(); // voice models that refused mp3: ask them for PCM straight away next time

// Words the speech-to-text model should expect (sent as a hint to models that take one)
const VOCAB = 'RICS APC final assessment interview, Quantity Surveying and Construction pathway. '
  + 'Terms: NRM 1, NRM 2, NRM 3, POMI, SMM7, ICMS, JCT, NEC4, FIDIC, RIBA Plan of Work, BCIS, CDM, BIM, CIOB, '
  + 'Rules of Conduct, competencies, Level 1, Level 2, Level 3, case study, cost plan, cost estimate, bill of quantities, '
  + 'variations, valuations, final account, retention, liquidated damages, loss and expense, extension of time, '
  + 'contract sum, provisional sums, prime cost, preliminaries, contingency, tender, procurement, two-stage tendering, '
  + 'design and build, subcontractor, payment notice, pay less notice, adjudication, mediation, arbitration.';

async function competencyNames() {
  try { return (await q('select name from competencies order by sort, id')).rows.map((r) => r.name).join(', '); } catch { return ''; }
}

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
    const { tts, stt } = await loadModels();
    const { model, voice } = await chosenVoice(req.user);
    res.json({
      models: tts, stt,
      defaults: { voiceModel: config.voiceModel, voiceName: config.voiceName, voiceSttModel: config.voiceSttModel, voiceChatModel: config.voiceChatModel },
      current: { model, voice },
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not load the voice list: ' + err.message });
  }
});

// One spoken turn (the whole turn at once, so the model hears every word in context) -> text.
// Uses the voice input model (accurate, with RICS vocabulary hints); falls back to the Live speech-to-text model.
router.post('/voice/transcribe', requireKey, async (req, res) => {
  const { audio, format = 'wav' } = req.body || {};
  if (typeof audio !== 'string' || !audio) return res.status(400).json({ error: 'Missing audio.' });
  if (audio.length > MAX_AUDIO_BASE64) return res.status(413).json({ error: 'That turn was too long. Please speak in shorter turns.' });
  const started = Date.now();
  const vocab = `${VOCAB} Competencies: ${await competencyNames()}. ${String(req.user.profile || '').slice(0, 300)}`.slice(0, 1500);
  try {
    const out = await speechToText(req.user, audio, format, {
      model: req.user.prefs?.voiceSttModel, fallback: config.voiceSttModel, vocab, kind: 'voice_stt',
    });
    console.log(`[voice] heard ${out.text.length} chars model=${out.model} ${Date.now() - started}ms cost=${out.cost ?? '-'}`);
    res.json({ text: out.text.trim(), cost: out.cost, ms: Date.now() - started });
  } catch (err) {
    console.error('[voice] stt', err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.status ? err.message : 'Speech-to-text error: ' + err.message });
  }
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

// Text-to-speech for one chunk of a reply. mp3 is streamed to the browser as it arrives, so playback starts
// on the first bytes; PCM-only models are wrapped as WAV. The cost is estimated from the model's per-character
// price (the speech API returns audio, not a cost), recorded as voice, and added to the reply's cost:
// to messageId, or (reply not saved yet) to chatId's next reply.
async function speak(req, res, { text, chatId, messageId }) {
  text = String(text || '').trim().slice(0, MAX_SPEAK_CHARS);
  if (!text) return res.status(400).json({ error: 'Nothing to say.' });
  const { model, voice, info } = await chosenVoice(req.user);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const call = (format) => fetch(`${OPENROUTER}/audio/speech`, {
    method: 'POST',
    headers: orHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ model, input: text, ...(voice && { voice }), response_format: format }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
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
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      console.error('[speak]', r.status, err?.error?.message);
      return res.status(502).json({ error: err?.error?.message || `Voice failed (${r.status})` });
    }
    const cost = info?.perChar ? info.perChar * text.length : null;
    recordUsage(req.user.id, 'voice_tts', cost);
    const mId = Number(messageId);
    const cId = Number(chatId);
    if (cost && mId > 0) {
      q(`update chat_messages m set cost = coalesce(m.cost, 0) + $2
           from chats c where m.id = $1 and m.chat_id = c.id and c.user_id = $3`, [mId, cost, req.user.id])
        .catch((e) => console.error('[speak] cost', e.message));
    } else if (cost && cId > 0) {
      const key = `${req.user.id}:${cId}`;
      pendingVoice.set(key, (pendingVoice.get(key) || 0) + cost);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (cost !== null) res.setHeader('X-Cost', String(cost));
    const pcm = format === 'pcm' || /pcm/i.test(r.headers.get('content-type') || '');
    if (pcm) {
      res.setHeader('Content-Type', 'audio/wav');
      return res.end(pcmToWav(Buffer.from(await r.arrayBuffer())));
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.flushHeaders?.();
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (err.name === 'AbortError' && controller.signal.aborted) return; // the browser stopped listening
    console.error('[speak] error', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Voice service error: ' + err.message });
    else res.end();
  }
}

// GET (an <audio> element streams it): ?t=<text>&c=<chatId>&m=<messageId>
router.get('/speak', requireKey, (req, res) => speak(req, res, { text: req.query.t, chatId: req.query.c, messageId: req.query.m }));
router.post('/speak', requireKey, (req, res) => speak(req, res, req.body || {}));
