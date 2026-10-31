// OpenRouter settings, model lists and per-user cost tracking, shared by the API routes

import { q } from './db.js';
import { isModelId, toAnswerModels, toSttModels, toTtsModels } from '../public/models.js';

export const config = {
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  sttModel: process.env.STT_MODEL || 'openai/whisper-large-v3-turbo',
  answerModel: process.env.ANSWER_MODEL || 'anthropic/claude-sonnet-5.5',
  // Fast, cheap model that decides whether speech is a question before the answer model is called
  detectModel: process.env.DETECT_MODEL || 'anthropic/claude-haiku-5.5',
  // Default thinking level. Sonnet 5.5 always reasons (no "none"); reasoning tokens count toward max_tokens.
  answerReasoning: process.env.ANSWER_REASONING || 'low',
  // Decision model (OpenRouter Decisions API) for fast yes/no and routing choices. Set DECISION_MODEL= (empty) to turn off.
  decisionModel: process.env.DECISION_MODEL ?? 'typesafe/jev-1.14',
  sttLanguage: process.env.STT_LANGUAGE || 'en',
  // Voice mode: text-to-speech model and voice (cheap British voice by default)
  voiceModel: process.env.VOICE_MODEL || 'hexgrad/kokoro-82m',
  voiceName: process.env.VOICE_NAME || 'bm_george',
  // Voice mode: accurate speech-to-text with keyword hints, and a fast reply model (thinking off) for quick answers
  voiceSttModel: process.env.VOICE_STT_MODEL || 'openai/gpt-transcribe',
  voiceChatModel: process.env.VOICE_CHAT_MODEL || 'anthropic/claude-haiku-5.5',
  // Audio knowledge files: cheap, accurate transcription, and a cheap model that organises it into notes
  knowledgeSttModel: process.env.KNOWLEDGE_STT_MODEL || 'openai/whisper-large-v3',
  knowledgeModel: process.env.KNOWLEDGE_MODEL || 'anthropic/claude-haiku-5.5',
  publicUrl: process.env.PUBLIC_URL || 'https://localhost',
};

export const OPENROUTER = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

export function requireKey(req, res, next) {
  if (!config.openrouterKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY is not set on the server.' });
  next();
}

export function orHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.openrouterKey}`,
    'HTTP-Referer': config.publicUrl,
    'X-Title': 'APC Interview Assistant',
    ...extra,
  };
}

// Live OpenRouter model lists, cached so settings and requests don't refetch every time
const MODELS_TTL_MS = 60 * 60 * 1000;
let modelCache = { at: 0, answer: [], stt: [], tts: [] };

export async function loadModels() {
  if (modelCache.answer.length && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache;
  const get = async (query) => {
    const r = await fetch(`${OPENROUTER}/models${query}`, { headers: orHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`model list failed (${r.status})`);
    return (await r.json()).data || [];
  };
  const [chat, stt, tts] = await Promise.all([
    get(''), get('?output_modalities=transcription'),
    get('?output_modalities=speech').catch((err) => { console.error('[models] tts', err.message); return []; }),
  ]);
  modelCache = { at: Date.now(), answer: toAnswerModels(chat), stt: toSttModels(stt), tts: toTtsModels(tts) };
  return modelCache;
}

// Resolve the model a request asked for. Returns { id, info } or { error } for an unknown model.
// If the list cannot be loaded, the id is trusted and info is null.
export async function pickModel(wanted, fallback, kind) {
  const id = isModelId(wanted) ? wanted : fallback;
  let list;
  try { list = (await loadModels())[kind]; } catch (err) {
    console.error('[models]', err.message);
    return { id, info: null };
  }
  const info = list.find((m) => m.id === id);
  if (!info) return { error: `Model "${id}" is not available on OpenRouter. Choose another in Settings.` };
  return { id, info };
}

// Record what OpenRouter charged for a request, per user (never blocks the request)
export function recordUsage(userId, kind, cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return;
  q('insert into usage (user_id, kind, cost) values ($1, $2, $3)', [userId, kind, cost])
    .catch((err) => console.error('[usage]', err.message));
}

// { month: {stt, detect, answer, chat, voice, total, answers, chats, voiceTurns}, all: {...} } for one user, or keyed by user id for all
export async function usageTotals(userId = null) {
  const { rows } = await q(
    `select user_id, kind,
            sum(cost) as all_cost, count(*) as all_count,
            sum(cost) filter (where at >= date_trunc('month', now())) as month_cost,
            count(*) filter (where at >= date_trunc('month', now())) as month_count
       from usage ${userId ? 'where user_id = $1' : ''}
      group by user_id, kind`, userId ? [userId] : []);
  const empty = () => ({ stt: 0, detect: 0, answer: 0, chat: 0, voice: 0, knowledge: 0, total: 0, answers: 0, chats: 0, voiceTurns: 0 });
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { month: empty(), all: empty() });
    const u = byUser.get(r.user_id);
    for (const [period, cost, count] of [['month', r.month_cost, r.month_count], ['all', r.all_cost, r.all_count]]) {
      const c = Number(cost) || 0;
      // *_extra = follow-up suggestions and decision-model routing: part of the chat / live answer cost, not extra replies
      // voice_stt / voice_tts = voice mode speech in and out (the AI replies themselves count as Chat)
      const kind = r.kind === 'chat_extra' ? 'chat' : r.kind === 'answer_extra' ? 'answer' : r.kind.startsWith('voice_') ? 'voice' : r.kind;
      if (kind in u[period]) u[period][kind] += c;
      u[period].total += c;
      if (r.kind === 'answer') u[period].answers += Number(count) || 0;
      if (r.kind === 'chat') u[period].chats += Number(count) || 0;
      if (r.kind === 'voice_stt') u[period].voiceTurns += Number(count) || 0;
    }
  }
  if (userId) return byUser.get(userId) || { month: empty(), all: empty() };
  return byUser;
}
