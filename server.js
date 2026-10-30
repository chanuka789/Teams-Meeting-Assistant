// Teams Meeting Assistant - server
// Serves the web app and proxies speech-to-text + answer requests to OpenRouter,
// so the OpenRouter API key never reaches the browser.

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildAnswerMessages, isLikelyHallucination } from './lib/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT) || 3000,
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  appPassword: process.env.APP_PASSWORD || '',
  sttModel: process.env.STT_MODEL || 'openai/whisper-large-v3-turbo',
  answerModel: process.env.ANSWER_MODEL || 'anthropic/claude-sonnet-5.5',
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

// Speech-to-text: one short WAV segment -> text
app.post('/api/transcribe', async (req, res) => {
  if (!requireKey(res)) return;
  const { audio, format = 'wav' } = req.body || {};
  if (typeof audio !== 'string' || audio.length === 0) {
    return res.status(400).json({ error: 'Missing audio.' });
  }
  if (audio.length > MAX_AUDIO_BASE64) {
    return res.status(413).json({ error: 'Audio segment too large.' });
  }
  const started = Date.now();
  try {
    const body = {
      model: config.sttModel,
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
    res.json({ text, ms: Date.now() - started, usage: data.usage || null });
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
        model: config.answerModel,
        messages,
        stream: true,
        max_tokens: 250,
        temperature: 0,
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
          if (delta) res.write(delta);
          if (json.error) res.write(`\n[error: ${json.error.message || 'unknown'}]`);
        } catch {
          /* partial or non-JSON line, ignore */
        }
      }
    }
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
