// AI routes: model lists, speech-to-text, question detection and streamed answers.
// Model choices, profile and notes come from the signed-in user's saved settings.

import express from 'express';
import {
  buildAnswerMessages, buildDetectMessages, buildTidyMessages, parseDetectReply, isFillerOnly,
  isLikelyHallucination, isMostlyNonLatin, stripSoundTags, isNoneReply, isRepeatQuestion,
} from '../prompt.js';
import { reasoningParam, COST_MARK } from '../../public/models.js';
import { requireUser, requireAdmin } from '../auth.js';
import { config, OPENROUTER, requireKey, orHeaders, loadModels, pickModel, recordUsage } from '../openrouter.js';
import { searchKnowledge } from '../documents.js';
import { decisionsOn, detectWithJev, routeQuestion } from '../decisions.js';
import { ANSWER_STYLES } from '../../public/js/format.js';

export const router = express.Router();
router.use(requireUser);

export const MAX_AUDIO_BASE64 = 8 * 1024 * 1024; // ~6 MB of audio, far more than one segment
const prefs = (req) => req.user.prefs || {};

router.get('/models', requireKey, async (req, res) => {
  try {
    const { answer, stt } = await loadModels();
    res.json({
      answer,
      stt,
      defaults: {
        answerModel: config.answerModel, sttModel: config.sttModel, reasoning: config.answerReasoning,
        detectModel: config.detectModel, decisionModel: config.decisionModel,
        voiceSttModel: config.voiceSttModel, voiceChatModel: config.voiceChatModel,
        knowledgeSttModel: config.knowledgeSttModel, knowledgeModel: config.knowledgeModel,
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

// Speech-to-text with the user's model. Returns { text, cost }; throws with .status on failure.
// English only: drops sound tags, known silence hallucinations and non-Latin-script text.
// opts: { model (wanted id), fallback (default id), vocab (expected words, sent as a prompt to providers that take one), kind }
export async function speechToText(user, audio, format = 'wav', opts = {}) {
  const model = await pickModel(opts.model ?? user.prefs?.sttModel, opts.fallback || config.sttModel, 'stt');
  if (model.error) { const e = new Error(model.error); e.status = 400; throw e; }
  const body = { model: model.id, input_audio: { data: audio, format } };
  if (config.sttLanguage && config.sttLanguage !== 'auto') body.language = config.sttLanguage;
  // Vocabulary hints go through provider options (OpenAI and Groq take a free-form prompt); others ignore them
  if (opts.vocab) body.provider = { options: { openai: { prompt: opts.vocab }, groq: { prompt: opts.vocab.slice(0, 800) } } };
  const call = (b) => fetch(`${OPENROUTER}/audio/transcriptions`, {
    method: 'POST',
    headers: orHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(30000),
  });
  let r = await call(body);
  // A provider that rejects the hints: try once more without them
  if (r.status === 400 && body.provider) { delete body.provider; r = await call(body); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `Transcription failed (${r.status})`);
    e.status = 502;
    throw e;
  }
  let text = stripSoundTags(data.text || '');
  if (isLikelyHallucination(text) || isMostlyNonLatin(text)) text = '';
  const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
  recordUsage(user.id, opts.kind || 'stt', cost);
  return { text, cost, model: model.id };
}

// Speech-to-text: one short WAV segment -> text
router.post('/transcribe', requireKey, async (req, res) => {
  const { audio, format = 'wav' } = req.body || {};
  if (typeof audio !== 'string' || audio.length === 0) return res.status(400).json({ error: 'Missing audio.' });
  if (audio.length > MAX_AUDIO_BASE64) return res.status(413).json({ error: 'Audio segment too large.' });
  const started = Date.now();
  try {
    const { text, cost } = await speechToText(req.user, audio, format);
    res.json({ text, ms: Date.now() - started, cost });
  } catch (err) {
    console.error('[stt]', err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.status ? err.message : 'Transcription service error: ' + err.message });
  }
});

// Ask the fast chat model (Haiku) a detection or tidy prompt. Returns { content, cost }; throws with .status on failure.
export async function askDetectModel(req, model, messages, kind = 'detect') {
  const reasoning = model.info ? reasoningParam(model.info, 'none') : undefined;
  const r = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: orHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: model.id,
      messages,
      // Lowest reasoning the model allows; room for it plus a one-line reply
      max_tokens: reasoning && reasoning.effort !== 'none' ? 1500 : 150,
      ...(reasoning && { reasoning }),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `Question detection failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
  recordUsage(req.user.id, kind, cost);
  return { content: data.choices?.[0]?.message?.content, cost };
}

export const addCost = (...c) => (c.some((x) => typeof x === 'number') ? c.reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0) : null);
// Decision model thresholds (probability of "yes"), see the [detect] log to tune them
const IS_QUESTION_MIN = 0.5;
const NEEDS_TIDY_MIN = 0.5;

// Question detection: latest speech + recent transcript -> { question | null }.
// With the decision model on: Jev decides "question?" and "needs tidying?" in ~0.1 s; Haiku is called only to
// tidy a real question. Without it (off, or Jev failed): Haiku decides and writes the question in one call.
router.post('/detect', requireKey, async (req, res) => {
  const { latest = '', transcript = '', answered = [] } = req.body || {};
  const text = String(latest).trim();
  if (!text || isFillerOnly(text)) return res.json({ question: null, skipped: true, cost: 0 });
  const model = await pickModel(prefs(req).detectModel, config.detectModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const ctx = {
    latest: text.slice(0, 2000),
    transcript: String(transcript).slice(-2500),
    answered: (Array.isArray(answered) ? answered : []).slice(-5).map((x) => String(x).slice(0, 300)),
  };
  const started = Date.now();
  // Temporary diagnostic while tuning detection. Remove once tuned.
  const log = (how, question, cost) => console.log(`[detect] ${question ? 'QUESTION' : 'none'} via ${how} ${Date.now() - started}ms cost=${cost ?? '-'} for: "${text.slice(0, 80)}"`
    + (question ? ` -> "${question.slice(0, 80)}"` : ''));
  // A question already answered is never answered again (the models sometimes bring back the previous one)
  const reply = (how, question, cost) => {
    if (question && isRepeatQuestion(question, ctx.answered)) {
      log(`${how} repeat`, null, cost);
      return res.json({ question: null, repeat: true, cost });
    }
    log(how, question, cost);
    return res.json({ question, cost });
  };
  try {
    const jev = decisionsOn(req.user) ? await detectWithJev(req.user, ctx) : null;
    if (jev) {
      const how = `jev(q=${jev.isQuestion.toFixed(2)} tidy=${jev.needsTidy.toFixed(2)} ${jev.ms}ms)`;
      if (jev.isQuestion < IS_QUESTION_MIN) return reply(how, null, jev.cost);
      if (jev.needsTidy < NEEDS_TIDY_MIN) return reply(how, ctx.latest, jev.cost);
      // A real question that needs tidying: Haiku rewrites it (the raw speech is used if that fails)
      let tidy = null;
      try { tidy = await askDetectModel(req, model, buildTidyMessages(ctx)); } catch (err) { console.error('[detect] tidy', err.message); }
      // Tidy said NONE: no new question in the latest speech. Raw speech is used only when tidy failed.
      const question = tidy ? parseDetectReply(tidy.content) : ctx.latest;
      const cost = addCost(jev.cost, tidy?.cost);
      return reply(`${how}+tidy`, question, cost);
    }
    const out = await askDetectModel(req, model, buildDetectMessages(ctx));
    reply(model.id, parseDetectReply(out.content), out.cost);
  } catch (err) {
    console.error('[detect] error', err.message);
    res.status(502).json({ error: err.status ? err.message : 'Question detection error: ' + err.message });
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
  // The request may carry the model and thinking level chosen a moment ago (prefs are saved with a short delay)
  const model = await pickModel(req.body?.model || p.answerModel, config.answerModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const wantedReasoning = (typeof req.body?.reasoning === 'string' && req.body.reasoning) || p.reasoning || config.answerReasoning;
  // Without model info (list unavailable) only the default model gets the default reasoning setting.
  const reasoning = model.info
    ? reasoningParam(model.info, wantedReasoning)
    : model.id === config.answerModel ? { effort: config.answerReasoning, exclude: true } : undefined;

  // The decision model points the search at the likely competency and source (case study or library)
  const route = decisionsOn(req.user)
    ? await routeQuestion(req.user, 'answer_extra', { question: String(latest).slice(0, 1000), context: String(transcript).slice(-800) })
    : null;
  let hits = [];
  try {
    hits = await searchKnowledge(req.user.id, String(latest).slice(0, 1000), 7000, route);
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
    const routeLog = route ? ` route=${route.source || '-'}/${route.competency || '-'}(${route.ms}ms)` : '';
    console.log(`[answer] ${kind} model=${model.id} style=${style || 'default'} reasoning=${reasoning?.effort || '-'} source=${source} `
      + `docs=${knowledge.length}${routeLog} finish=${finish || '-'} cost=${cost ?? '-'} ${Date.now() - started}ms`);
    res.write(COST_MARK + JSON.stringify({ cost: addCost(cost, route?.cost), sources }));
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') return; // client went away
    console.error('[answer] error', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Answer service error: ' + err.message });
    else res.end(`\n[error: ${err.message}]`);
  }
});
