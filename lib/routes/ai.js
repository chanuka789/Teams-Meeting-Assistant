// AI routes: model lists, speech-to-text, question detection and streamed answers.
// Model choices, profile and notes come from the signed-in user's saved settings.

import express from 'express';
import {
  buildAnswerMessages, buildDetectMessages, parseDetectReply, isFillerOnly,
  isLikelyHallucination, isMostlyNonLatin, stripSoundTags, isNoneReply,
} from '../prompt.js';
import { reasoningParam, COST_MARK } from '../../public/models.js';
import { requireUser, requireAdmin } from '../auth.js';
import { config, OPENROUTER, requireKey, orHeaders, loadModels, pickModel, recordUsage } from '../openrouter.js';
import { searchKnowledge } from '../documents.js';
import { ANSWER_STYLES } from '../../public/js/format.js';

export const router = express.Router();
router.use(requireUser);

const MAX_AUDIO_BASE64 = 8 * 1024 * 1024; // ~6 MB of audio, far more than one segment
const prefs = (req) => req.user.prefs || {};

router.get('/models', requireKey, async (req, res) => {
  try {
    const { answer, stt } = await loadModels();
    res.json({
      answer,
      stt,
      defaults: {
        answerModel: config.answerModel, sttModel: config.sttModel, reasoning: config.answerReasoning,
        detectModel: config.detectModel,
      },
    });
  } catch (err) {
    console.error('[models]', err.message);
    res.status(502).json({ error: 'Could not load the OpenRouter model list: ' + err.message });
  }
});

// Spend on the OpenRouter key (total used and limit): admin only, it is the owner's account
router.get('/key-usage', requireAdmin, requireKey, async (req, res) => {
  try {
    const r = await fetch(`${OPENROUTER}/key`, { headers: orHeaders(), signal: AbortSignal.timeout(10000) });
    const data = (await r.json().catch(() => ({}))).data;
    if (!r.ok || !data) return res.status(502).json({ error: `Could not read key usage (${r.status})` });
    res.json({ usage: data.usage ?? null, limit: data.limit ?? null, limitRemaining: data.limit_remaining ?? null });
  } catch (err) {
    res.status(502).json({ error: 'Could not read key usage: ' + err.message });
  }
});

// Speech-to-text: one short WAV segment -> text
router.post('/transcribe', requireKey, async (req, res) => {
  const { audio, format = 'wav' } = req.body || {};
  if (typeof audio !== 'string' || audio.length === 0) return res.status(400).json({ error: 'Missing audio.' });
  if (audio.length > MAX_AUDIO_BASE64) return res.status(413).json({ error: 'Audio segment too large.' });
  const model = await pickModel(prefs(req).sttModel, config.sttModel, 'stt');
  if (model.error) return res.status(400).json({ error: model.error });
  const started = Date.now();
  try {
    const body = { model: model.id, input_audio: { data: audio, format } };
    if (config.sttLanguage && config.sttLanguage !== 'auto') body.language = config.sttLanguage;
    const r = await fetch(`${OPENROUTER}/audio/transcriptions`, {
      method: 'POST',
      headers: orHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `Transcription failed (${r.status})`;
      console.error('[stt]', r.status, msg);
      return res.status(502).json({ error: msg });
    }
    // English only: drop sound tags, known silence hallucinations and non-Latin-script text
    let text = stripSoundTags(data.text || '');
    if (isLikelyHallucination(text) || isMostlyNonLatin(text)) text = '';
    const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
    recordUsage(req.user.id, 'stt', cost);
    res.json({ text, ms: Date.now() - started, cost });
  } catch (err) {
    console.error('[stt] error', err.message);
    res.status(502).json({ error: 'Transcription service error: ' + err.message });
  }
});

// Question detection: latest speech + recent transcript -> { question | null } using a fast model
router.post('/detect', requireKey, async (req, res) => {
  const { latest = '', transcript = '', answered = [] } = req.body || {};
  const text = String(latest).trim();
  if (!text || isFillerOnly(text)) return res.json({ question: null, skipped: true, cost: 0 });
  const model = await pickModel(prefs(req).detectModel, config.detectModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const started = Date.now();
  try {
    const reasoning = model.info ? reasoningParam(model.info, 'none') : undefined;
    const r = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: orHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: model.id,
        messages: buildDetectMessages({
          latest: text.slice(0, 2000),
          transcript: String(transcript).slice(-2500),
          answered: (Array.isArray(answered) ? answered : []).slice(-5).map((x) => String(x).slice(0, 300)),
        }),
        // Lowest reasoning the model allows; room for it plus a one-line reply
        max_tokens: reasoning && reasoning.effort !== 'none' ? 1500 : 150,
        ...(reasoning && { reasoning }),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `Question detection failed (${r.status})`;
      console.error('[detect]', r.status, msg);
      return res.status(502).json({ error: msg });
    }
    const question = parseDetectReply(data.choices?.[0]?.message?.content);
    const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
    recordUsage(req.user.id, 'detect', cost);
    // Temporary diagnostic while tuning detection. Remove once tuned.
    console.log(`[detect] ${question ? 'QUESTION' : 'none'} ${Date.now() - started}ms cost=${cost ?? '-'} for: "${text.slice(0, 80)}"`
      + (question ? ` -> "${question.slice(0, 80)}"` : ''));
    res.json({ question, cost });
  } catch (err) {
    console.error('[detect] error', err.message);
    res.status(502).json({ error: 'Question detection error: ' + err.message });
  }
});

// Answer: question + recent transcript + the user's profile, notes, library and case study -> streamed text.
// Response: the answer text, then COST_MARK + {"cost", "sources"} when the stream ends.
router.post('/answer', requireKey, async (req, res) => {
  const { latest = '', transcript = '' } = req.body || {};
  const source = ['typed', 'detected', 'speech'].includes(req.body?.source) ? req.body.source : 'speech';
  if (!String(latest).trim()) return res.status(400).json({ error: 'Missing question.' });
  const p = prefs(req);
  const style = ANSWER_STYLES.some((x) => x.id === req.body?.style) ? req.body.style : p.answerStyle;
  const model = await pickModel(p.answerModel, config.answerModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const wantedReasoning = p.reasoning || config.answerReasoning;
  // Without model info (list unavailable) only the default model gets the default reasoning setting.
  const reasoning = model.info
    ? reasoningParam(model.info, wantedReasoning)
    : model.id === config.answerModel ? { effort: config.answerReasoning, exclude: true } : undefined;

  let hits = [];
  try {
    hits = await searchKnowledge(req.user.id, String(latest).slice(0, 1000));
  } catch (err) {
    console.error('[search]', err.message);
  }
  const knowledge = hits.map((h) => ({
    doc: h.scope === 'case_study' ? `My case study · ${h.doc}` : `RICS library · ${h.competency || 'General'} · ${h.doc}`,
    text: h.text,
  }));
  const sources = [...new Map(hits.map((h) => [h.doc, { name: h.doc, scope: h.scope }])).values()];

  const messages = buildAnswerMessages({
    latest: String(latest).slice(0, 4000),
    transcript: String(transcript).slice(-6000),
    notes: req.user.notes.slice(0, 60000),
    role: req.user.profile.slice(0, 2000),
    source,
    knowledge,
    style,
  });

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const r = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: orHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: model.id,
        messages,
        stream: true,
        // Room for reasoning plus the answer; the prompt keeps the visible answer short.
        max_tokens: 3000,
        ...(reasoning && { reasoning }),
      }),
      signal: controller.signal,
    });

    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      const msg = data?.error?.message || `Answer failed (${r.status})`;
      console.error('[answer]', r.status, msg);
      return res.status(502).json({ error: msg });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Parse OpenRouter SSE and forward only the text deltas
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let finish = '';
    let cost = null;
    const started = Date.now();
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue; // skip comments / keep-alives
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { reply += delta; res.write(delta); }
          finish = json.choices?.[0]?.finish_reason || finish;
          if (typeof json.usage?.cost === 'number') cost = json.usage.cost; // last SSE message
          if (json.error) {
            console.error('[answer] stream error', json.error.message);
            res.write(`\n[error: ${json.error.message || 'unknown'}]`);
          }
        } catch {
          /* partial or non-JSON line, ignore */
        }
      }
    }
    const kind = !reply.trim() ? 'EMPTY' : isNoneReply(reply) ? 'NONE' : 'answered';
    recordUsage(req.user.id, 'answer', cost);
    console.log(`[answer] ${kind} model=${model.id} style=${style || 'default'} reasoning=${reasoning?.effort || '-'} source=${source} `
      + `docs=${knowledge.length} finish=${finish || '-'} cost=${cost ?? '-'} ${Date.now() - started}ms`);
    res.write(COST_MARK + JSON.stringify({ cost, sources }));
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') return; // client went away
    console.error('[answer] error', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Answer service error: ' + err.message });
    else res.end(`\n[error: ${err.message}]`);
  }
});
