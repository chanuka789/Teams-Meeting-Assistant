// Fast typed decisions with a decision model (TypeSafe Jev on the OpenRouter Decisions API).
// Jev returns probabilities, not text. Every helper here returns null when Jev is off, slow or failing,
// so callers fall back to the normal behaviour.

import { q } from './db.js';
import { config, OPENROUTER, orHeaders, recordUsage } from './openrouter.js';

// POST /api/alpha/decisions, next to the OpenAI-style /api/v1 base
export const DECISIONS_URL = process.env.DECISIONS_URL || `${OPENROUTER.replace(/\/v1\/?$/, '')}/alpha/decisions`;
const TIMEOUT_MS = 4000;

// On unless the user switched it off in Settings (and a decision model is configured)
export const decisionsOn = (user) => Boolean(config.decisionModel) && user?.prefs?.useDecisions !== false;

// One request with several questions. Returns { answers, cost, ms } or null on any failure.
export async function decide(user, kind, state, questions) {
  if (!decisionsOn(user)) return null;
  const started = Date.now();
  try {
    const r = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: orHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: config.decisionModel, state, questions, user: `u${user.id}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.answers) {
      console.error('[jev]', r.status, data?.error?.message || 'no answers');
      return null;
    }
    const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
    recordUsage(user.id, kind, cost);
    return { answers: data.answers, cost, ms: Date.now() - started };
  } catch (err) {
    console.error('[jev] error', err.message);
    return null;
  }
}

// ---------- question detection ----------

export const DETECT_QUESTIONS = {
  is_question: {
    type: 'noul',
    instructions: 'In this live RICS APC final interview, have the assessors just asked the candidate a new question, or given a prompt the candidate must answer? Judge latest_speech, using recent_transcript for context.',
    criteria: {
      true: 'A direct question, or an instruction such as "Tell us about…", "Talk me through…", "Explain…", "Describe…", "What would you advise…", even without a question mark or with transcription errors. A question may be split across the last few transcript lines.',
      false: 'Greetings, small talk, filler ("mm-hmm", "right", "okay"), feedback ("good", "that was concise"), interview admin ("can you hear me?", "let\'s move on to ethics", "first question"), noise, non-English or meaningless text, or a repeat of a question in questions_already_answered.',
    },
  },
  needs_tidy: {
    type: 'noul',
    instructions: 'Would the question need rewriting before it can be shown to the candidate as a clear question?',
    criteria: {
      true: 'latest_speech has transcription errors (especially in technical terms such as NRM, POMI, RICS, JCT, FIDIC, NEC), the question is split across earlier transcript lines, or it is mixed with other talk.',
      false: 'latest_speech on its own is already one clear, complete question in correct English.',
    },
  },
};

// { isQuestion: p, needsTidy: p, cost, ms } or null
export async function detectWithJev(user, { latest, transcript, answered }) {
  const out = await decide(user, 'detect', {
    latest_speech: latest,
    recent_transcript: transcript || '',
    questions_already_answered: answered,
  }, DETECT_QUESTIONS);
  const isQ = out?.answers?.is_question?.noul;
  if (typeof isQ !== 'number') return null;
  const tidy = out.answers.needs_tidy?.noul;
  return { isQuestion: isQ, needsTidy: typeof tidy === 'number' ? tidy : 1, cost: out.cost, ms: out.ms };
}

// ---------- search routing: competency, case study or library, documents needed ----------

let compCache = { at: 0, rows: [] };
async function competencies() {
  if (compCache.rows.length && Date.now() - compCache.at < 5 * 60 * 1000) return compCache.rows;
  const { rows } = await q('select id, name, category from competencies order by sort, id');
  compCache = { at: Date.now(), rows };
  return rows;
}

const SOURCE_QUESTION = {
  type: 'choice',
  instructions: 'Where is the answer to this question most likely to be found?',
  criteria: {
    case_study: "The candidate's own project, case study or experience: what they did, decided, advised, reported, their figures or their role.",
    library: 'General technical knowledge: RICS standards and guidance, definitions, contracts, measurement rules, ethics rules, processes.',
    both: 'Both: general knowledge applied to the candidate\'s own project, or not clear.',
  },
};

// Thresholds: below these a decision is ignored and the normal search runs
export const MIN_CHOICE_CONFIDENCE = 0.35;
export const SKIP_SEARCH_BELOW = 0.2;

// { competencyId, competency, source, needsDocuments, cost, ms } or null.
// withSkip adds the "does this need documents at all?" question (chat).
export async function routeQuestion(user, kind, { question, context = '' }, { withSkip = false } = {}) {
  let comps = [];
  try { comps = await competencies(); } catch (err) { console.error('[jev] competencies', err.message); }
  const questions = { source: SOURCE_QUESTION };
  if (comps.length) {
    questions.competency = {
      type: 'choice',
      instructions: 'Which RICS APC competency (Quantity Surveying and Construction pathway) is this question mainly about?',
      criteria: {
        ...Object.fromEntries(comps.map((c) => [`c${c.id}`, `${c.name}${c.category ? ` (${c.category})` : ''}`])),
        general: 'No single competency, or not about a competency (greetings, interview admin, general chat).',
      },
    };
  }
  if (withSkip) {
    questions.needs_documents = {
      type: 'noul',
      instructions: 'Does a good reply to this message need facts from study documents (RICS standards and guidance, competency material, or the candidate\'s case study)?',
      criteria: {
        true: 'A question about technical content, standards, competencies, ethics, or the candidate\'s project.',
        false: 'Greetings, thanks, small talk, or a request only about the previous reply ("shorter please", "make it bullet points", "translate that").',
      },
    };
  }
  const out = await decide(user, kind, { question, previous_context: context }, questions);
  if (!out) return null;
  const a = out.answers;
  const pick = (x) => (x?.type === 'choice' && (x.confidence ?? 1) >= MIN_CHOICE_CONFIDENCE ? x.choice : null);
  const compKey = pick(a.competency);
  const comp = compKey && compKey !== 'general' ? comps.find((c) => `c${c.id}` === compKey) : null;
  const source = pick(a.source);
  return {
    competencyId: comp ? comp.id : null,
    competency: comp ? comp.name : null,
    source: ['case_study', 'library', 'both'].includes(source) ? source : null,
    needsDocuments: typeof a.needs_documents?.noul === 'number' ? a.needs_documents.noul : 1,
    cost: out.cost,
    ms: out.ms,
  };
}
