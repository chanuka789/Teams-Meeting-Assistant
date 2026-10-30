// Teams Meeting Assistant - server
// Serves the web app and proxies speech-to-text + answer requests to OpenRouter,
// so the OpenRouter API key never reaches the browser.

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildAnswerMessages, isLikelyHallucination, isNoneReply } from './lib/prompt.js';
import { isModelId, toAnswerModels, toSttModels, reasoningParam, COST_MARK } from './public/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT) || 3000,
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  appPassword: process.env.APP_PASSWORD || '',
  sttModel: process.env.STT_MODEL || 'openai/whisper-large-v3-turbo',
  answerModel: process.env.ANSWER_MODEL || 'anthropic/claude-sonnet-5.5',
  // Default thinking level. Sonnet 5.5 always reasons (no "none"); reasoning tokens count toward max_tokens.
  answerReasoning: process.env.ANSWER_REASONING || 'low',
  sttLanguage: process.env.STT_LANGUAGE || 'en',
  publicUrl: process.env.PUBLIC_URL || 'https://localhost',
};

const OPENROUTER = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MAX_AUDIO_BASE64 = 8 * 1024 * 1024; // ~6 MB of audio, far more than one segment

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(config.openrouterKey) });
});

// Public settings the client needs (no secrets)
app.get('/api/config', (req, res) => {
  res.json({
    passwordRequired: Boolean(config.appPassword),
    keyConfigured: Boolean(config.openrouterKey),
    sttModel: config.sttModel,
    answerModel: config.answerModel,
    answerReasoning: config.answerReasoning,
  });
});

// Password check for all other /api routes
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.use('/api', (req, res, next) => {
  if (!config.appPassword) return next();
  const given = req.get('x-app-password') || '';
  if (!safeEqual(given, config.appPassword)) {
    return res.status(401).json({ error: 'Wrong or missing app password.' });
  }
  next();
});

app.post('/api/login', (req, res) => res.json({ ok: true }));

function requireKey(res) {
  if (!config.openrouterKey) {
    res.status(500).json({ error: 'OPENROUTER_API_KEY is not set on the server.' });
    return false;
  }
  return true;
}

function orHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.openrouterKey}`,
    'HTTP-Referer': config.publicUrl,
    'X-Title': 'Teams Meeting Assistant',
    ...extra,
  };
}

// Live OpenRouter model lists, cached so settings and requests don't refetch every time
const MODELS_TTL_MS = 60 * 60 * 1000;
let modelCache = { at: 0, answer: [], stt: [] };

async function loadModels() {
  if (modelCache.answer.length && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache;
  const get = async (query) => {
    const r = await fetch(`${OPENROUTER}/models${query}`, { headers: orHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`model list failed (${r.status})`);
    return (await r.json()).data || [];
  };
  const [chat, stt] = await Promise.all([get(''), get('?output_modalities=transcription')]);
  modelCache = { at: Date.now(), answer: toAnswerModels(chat), stt: toSttModels(stt) };
  return modelCache;
}

// Resolve the model a request asked for. Returns { id, info } or { error } for an unknown model.
// If the list cannot be loaded, the id is trusted and info is null.
async function pickModel(wanted, fallback, kind) {
  const id = isModelId(wanted) ? wanted : fallback;
  let list;
  try { list = (await loadModels())[kind]; } catch (err) {
    console.error('[models]', err.message);
    return { id, info: null };
  }
  const info = list.find((m) => m.id === id);
  if (!info) return { error: `Model "${id}" is not available on OpenRouter. Choose another in Notes & settings.` };
  return { id, info };
}

app.get('/api/models', async (req, res) => {
  try {
    const { answer, stt } = await loadModels();
    res.json({
      answer,
      stt,
      defaults: { answerModel: config.answerModel, sttModel: config.sttModel, reasoning: config.answerReasoning },
    });
  } catch (err) {
    console.error('[models]', err.message);
    res.status(502).json({ error: 'Could not load the OpenRouter model list: ' + err.message });
  }
});

// Spend on this OpenRouter key (total used and limit), shown in settings
app.get('/api/usage', async (req, res) => {
  if (!requireKey(res)) return;
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
app.post('/api/transcribe', async (req, res) => {
  if (!requireKey(res)) return;
  const { audio, format = 'wav', model: wantedModel } = req.body || {};
  if (typeof audio !== 'string' || audio.length === 0) {
    return res.status(400).json({ error: 'Missing audio.' });
  }
  if (audio.length > MAX_AUDIO_BASE64) {
    return res.status(413).json({ error: 'Audio segment too large.' });
  }
  const model = await pickModel(wantedModel, config.sttModel, 'stt');
  if (model.error) return res.status(400).json({ error: model.error });
  const started = Date.now();
  try {
    const body = {
      model: model.id,
      input_audio: { data: audio, format },
    };
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
    let text = (data.text || '').trim();
    if (isLikelyHallucination(text)) text = '';
    const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
    res.json({ text, ms: Date.now() - started, cost });
  } catch (err) {
    console.error('[stt] error', err.message);
    res.status(502).json({ error: 'Transcription service error: ' + err.message });
  }
});

// Answer: recent transcript + latest utterance -> streamed "NONE" or "Q:/A:" text
app.post('/api/answer', async (req, res) => {
  if (!requireKey(res)) return;
  const { latest = '', transcript = '', notes = '', role = '', manual = false } = req.body || {};
  if (!latest.trim()) return res.status(400).json({ error: 'Missing latest text.' });
  const model = await pickModel(req.body.model, config.answerModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const wantedReasoning = typeof req.body.reasoning === 'string' ? req.body.reasoning : config.answerReasoning;
  // Without model info (list unavailable) only the default model gets the default reasoning setting.
  const reasoning = model.info
    ? reasoningParam(model.info, wantedReasoning)
    : model.id === config.answerModel ? { effort: config.answerReasoning, exclude: true } : undefined;

  const messages = buildAnswerMessages({
    latest: String(latest).slice(0, 4000),
    transcript: String(transcript).slice(-6000),
    notes: String(notes).slice(0, 60000),
    role: String(role).slice(0, 500),
    manual: Boolean(manual),
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
        // Room for reasoning plus the answer; the prompt keeps the visible answer to about 7-10 sentences.
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
    console.log(`[answer] ${kind} model=${model.id} reasoning=${reasoning?.effort || '-'} manual=${Boolean(manual)} finish=${finish || '-'} cost=${cost ?? '-'} ${Date.now() - started}ms`);
    // Temporary diagnostic: why spoken text is judged "no question". Remove once tuned.
    if (kind === 'NONE') console.log(`[answer] NONE for: "${String(latest).slice(0, 80)}"`);
    if (cost !== null) res.write(COST_MARK + JSON.stringify({ cost }));
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') return; // client went away
    console.error('[answer] error', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Answer service error: ' + err.message });
    else res.end(`\n[error: ${err.message}]`);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(config.port, () => {
  console.log(`Meeting assistant listening on :${config.port}`);
  console.log(`STT model: ${config.sttModel} | Answer model: ${config.answerModel}`);
  if (!config.openrouterKey) console.warn('WARNING: OPENROUTER_API_KEY is not set.');
  if (!config.appPassword) console.warn('WARNING: APP_PASSWORD is not set - the app is open to anyone with the URL.');
});
