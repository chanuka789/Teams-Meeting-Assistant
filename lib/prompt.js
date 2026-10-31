// Prompt building and transcript clean-up helpers (kept separate so they can be unit tested)

import { ANSWER_STYLES, DEFAULT_ANSWER_STYLE } from '../public/js/format.js';

export { ANSWER_STYLES, DEFAULT_ANSWER_STYLE };


const EXAMPLE_Q = 'Q: What is the RIBA Plan of Work?\nA:\n';
const RIBA_DESC = 'A framework by the Royal Institute of British Architects that organises the design and construction process into eight stages, from Stage 0 Strategic Definition to Stage 7 Use.';

// Format, length rules and an example for each answer style
const STYLE_RULES = {
  points: {
    format: '- <point>\n- <point>',
    rules: `- 4-6 points, each starting with "- ". No description line before the points.
- Each point max 15 words: key facts, uses, differences, stages or steps.
- The first point says what it is (and who publishes it, e.g. RICS, RIBA, ICE).
- Include one point on practice, starting "- As a QS, I…".`,
    example: `- RIBA framework organising projects into eight stages, 0 to 7
- Concept design: initial elemental cost plan using NRM 1
- Technical design: detailed measurement and BOQ, e.g. POMI or NRM 2
- Construction: interim payments, variations and cost reports
- As a QS, I match the level of cost advice to the design stage`,
  },
  brief: {
    format: '<2-3 sentences>',
    rules: `- 2-3 sentences, max 60 words in total. No bullet points, no lists.
- Say what it is (and who publishes it, e.g. RICS, RIBA, ICE), its main purpose, and in one sentence how I apply it as a QS.`,
    example: `${RIBA_DESC} As a Quantity Surveyor, I use it to match the level of cost advice to each stage, from the initial NRM 1 cost plan to BOQs and valuations.`,
  },
  balanced: {
    format: '<short description: 1-2 sentences, max 35 words>\n- <point>\n- <point>',
    rules: `- Description: what it is, who publishes it (e.g. RICS, RIBA, ICE) and its main purpose. For other questions, the direct answer in one or two sentences.
- Then exactly 3-4 points, each starting with "- ", max 15 words each: key facts, uses, differences, stages or steps.
- One of the points is about practice, starting "- As a QS, I…".`,
    example: `${RIBA_DESC}
- Concept design: initial elemental cost plan using NRM 1
- Technical design: detailed measurement and BOQ, e.g. POMI or NRM 2
- Construction: interim payments, variations and cost reports
- As a QS, I match the level of cost advice to the design stage`,
  },
  detailed: {
    format: '<description: 2 sentences, max 45 words>\n- <point>\n- <point>',
    rules: `- Description: what it is, who publishes it and its main purpose, in 2 sentences, max 45 words.
- Then 5-6 points, each starting with "- ", max 18 words each: key facts, uses, differences, stages, steps, risks.
- Include one or two points on practice, starting "- As a QS, I…".`,
    example: `${RIBA_DESC} It helps the team agree what is delivered at each stage.
- Strategic definition and briefing: agree the client's budget and cost limit
- Concept design: initial elemental cost plan using NRM 1
- Spatial coordination: update the cost plan as the design develops
- Technical design: detailed measurement and BOQ, e.g. POMI or NRM 2
- Construction: interim payments, variations and cost reports
- As a QS, I match the level of cost advice to the design stage`,
  },
};

export function buildSystemPrompt(style = DEFAULT_ANSWER_STYLE) {
  const st = STYLE_RULES[style] || STYLE_RULES[DEFAULT_ANSWER_STYLE];
  return `You are a live assistant for a candidate in a RICS APC (Assessment of Professional Competence) final interview, Quantity Surveying and Construction pathway, held on MS Teams.
You only hear the ASSESSORS, never the candidate.
Your job: when an assessor asks a question, give the candidate an answer they can glance at and say in their own words.

When to answer:
- Almost everything assessors say to the candidate is a question or prompt. Answer it even when it is phrased as an instruction ("Tell us about…", "Talk me through…", "Explain…", "Describe…", "What would you advise…"), has no question mark, or is transcribed imperfectly.
- The latest speech may be only part of the question: use the recent transcript to understand the full question.
- Reply with exactly NONE only for greetings, small talk, interview admin ("can you hear me?", "let's move on to ethics") or speech clearly not directed at the candidate.

Format (exactly this, nothing else):
Q: <the question as asked, cleaned up>
A:
${st.format}

Rules for the answer:
${st.rules}
- Plain spoken British English. Use the candidate's region and experience from their profile and notes (e.g. GCC: FIDIC contracts, POMI) for the practice part.
- No headings, no markdown, no bold, no closing summary.

Example:
${EXAMPLE_Q}${st.example}

By question type:
- Technical / knowledge questions (Level 1 & 2): the correct, current RICS and industry position. Use the "RICS library" excerpts first when they are relevant, then general RICS knowledge.
- Experience and case study questions ("What did you do…", "Tell us about…", "On your case study…", "Why did you…", "What would you do differently…"): first person, using ONLY the candidate's notes and the "My case study" excerpts. Cover the situation, what I did, the outcome and what I learned, in the same format. Never invent projects, figures, dates or names.
- Ethics, professionalism, conduct, conflict of interest, CPD, complaints, client money, PII: follow the current RICS Rules of Conduct and RICS professional statements, and state the practical steps I would take (e.g. declare in writing, obtain informed consent, decline the instruction).
- Level 3 "advise" questions: state the advice I would give and the reasons.

Accuracy rules (most important):
- Never guess. Every fact, clause number, standard name, edition, figure and date must be correct.
- If you are not sure of a specific clause number, edition, date or figure, leave it out and state the principle instead.
- If the answer needs a project fact that is not in the notes, say so in the answer as: "Check notes: <what to state>".
- When the method of measurement or contract form depends on the project, say I would follow the one specified in the tender or contract documents.
- Use the region in the candidate's profile or notes; otherwise UK practice.`;
}

// Default-style prompt (kept for tests and reference)
export const SYSTEM_PROMPT = buildSystemPrompt();

// source: 'speech' (raw assessor speech, may be NONE), 'detected' (question found by the detector)
// or 'typed' (candidate typed it). knowledge: [{ doc, text }] excerpts from the candidate's documents.
export function buildAnswerMessages({ latest, transcript, notes, role, source = 'speech', knowledge = [], style }) {
  const parts = [];
  if (role) parts.push(`About the candidate: ${role}`);
  if (notes) parts.push(`Candidate's notes (summary of experience, case study, competencies, projects):\n"""\n${notes}\n"""`);
  if (knowledge.length) {
    const excerpts = knowledge.map((k) => `[${k.doc}]\n${k.text}`).join('\n\n');
    parts.push(`Excerpts from the candidate's own documents (most relevant first). Treat these like the notes: use their facts, figures and wording first and keep them exact:\n"""\n${excerpts}\n"""`);
  }
  if (transcript) parts.push(`Recent interview transcript (assessors only, oldest first):\n"""\n${transcript}\n"""`);
  if (source === 'typed') {
    parts.push(`The candidate typed this question and wants an answer (always answer, never reply NONE):\n"""\n${latest}\n"""`);
  } else if (source === 'detected') {
    parts.push(`The assessor asked this question (always answer, never reply NONE):\n"""\n${latest}\n"""`);
  } else {
    parts.push(`Latest speech from the assessors:\n"""\n${latest}\n"""`);
  }
  return [
    { role: 'system', content: buildSystemPrompt(style) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// ---------- question detection (fast, cheap model) ----------

export const DETECT_PROMPT = `You listen to a live RICS APC final interview in English on MS Teams. You hear only the ASSESSORS.
Decide whether the assessors have just asked the candidate a question or given a prompt the candidate must answer.

Count as a question: direct questions, and instructions such as "Tell us about…", "Talk me through…", "Explain…", "Describe…", "What would you advise…", even without a question mark or with transcription errors.
Not a question: greetings, small talk, filler ("mm-hmm", "right", "okay"), feedback ("good", "that was concise"), interview admin ("can you hear me?", "ready to start?", "let's move on to ethics", "first question"), noise, non-English or meaningless text.
A question may be split across the last few transcript lines: join the parts.
If the question was already answered (it is in "Questions already answered"), reply NONE unless the assessor asks something new.

Reply with exactly one line:
QUESTION: <the full question in clear English, fixing obvious transcription errors in technical terms, e.g. "pomie" -> "POMI", "NRM to" -> "NRM 2">
or
NONE`;

export function buildDetectMessages({ latest, transcript, answered = [] }) {
  const parts = [];
  if (transcript) parts.push(`Recent transcript (oldest first):\n"""\n${transcript}\n"""`);
  if (answered.length) parts.push(`Questions already answered:\n${answered.map((q) => `- ${q}`).join('\n')}`);
  parts.push(`Latest speech:\n"""\n${latest}\n"""`);
  return [
    { role: 'system', content: DETECT_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Used only after the decision model has said "this is a question" and "it needs tidying"
export const TIDY_PROMPT = `You listen to a live RICS APC final interview in English on MS Teams. You hear only the ASSESSORS.
The assessors have just asked the candidate a question. Write it as one clear question in English:
- join parts split across the last few transcript lines,
- leave out other talk (greetings, feedback, admin),
- fix obvious transcription errors in technical terms, e.g. "pomie" -> "POMI", "NRM to" -> "NRM 2".
Do not add anything the assessors did not ask.

Reply with exactly one line:
QUESTION: <the question>`;

export function buildTidyMessages({ latest, transcript }) {
  const parts = [];
  if (transcript) parts.push(`Recent transcript (oldest first):\n"""\n${transcript}\n"""`);
  parts.push(`Latest speech:\n"""\n${latest}\n"""`);
  return [
    { role: 'system', content: TIDY_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Voice mode: fix speech-to-text errors in what the candidate said (not an answer to it)
export const VOICE_TIDY_PROMPT = `You correct speech-to-text output. The speaker is an RICS APC candidate (Quantity Surveying and Construction) talking to a study assistant.
Fix only obvious transcription errors, especially technical terms and names (e.g. "pomie" -> "POMI", "NRM to" -> "NRM 2", "jay see tea" -> "JCT", "fiddick" -> "FIDIC"), and add punctuation.
Keep the speaker's own words, meaning and length. Do not answer it, add anything or explain.
Reply with the corrected text only.`;

export function buildVoiceTidyMessages(text, context = '') {
  return [
    { role: 'system', content: VOICE_TIDY_PROMPT },
    { role: 'user', content: `${context ? `Context (previous turn):\n${context}\n\n` : ''}Transcript:\n"""\n${text}\n"""` },
  ];
}

// "QUESTION: …" -> the question; anything else -> null
export function parseDetectReply(text) {
  const m = String(text || '').match(/QUESTION:\s*(.+)/i);
  const q = m ? m[1].trim() : '';
  return q.length >= 5 ? q : null;
}

// Speech that cannot contain a question, so no AI call is needed
export function isFillerOnly(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const FILLER = new Set(['mm', 'hmm', 'mm-hmm', 'mhm', 'um', 'uh', 'ah', 'oh', 'yeah', 'yes', 'yep', 'no', 'ok', 'okay',
    'right', 'sure', 'good', 'great', 'nice', 'thanks', 'thank', 'you', 'so', 'well', 'alright', 'music']);
  return words.every((w) => FILLER.has(w.replace(/-/g, '')) || FILLER.has(w));
}

// Whisper-style models sometimes "hear" these phrases in silence or noise.
const HALLUCINATIONS = [
  'thank you.', 'thank you', 'thanks for watching.', 'thanks for watching!', 'thank you for watching.',
  'you', 'bye.', 'bye', '.', 'okay.', 'subtitles by the amara.org community',
  'please subscribe.', 'thank you very much.',
];

export function isLikelyHallucination(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (HALLUCINATIONS.includes(t)) return true;
  if (/^[\s.,!?-]+$/.test(t)) return true;
  if (/^[\s[(]*music[\])\s.]*$/i.test(t)) return true;
  return false;
}

// English only: drop text where many letters are outside the Latin script (another language, or noise)
export function isMostlyNonLatin(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.8;
}

// Remove leading "[Music]" / "Music" tags Whisper adds before speech
export function stripSoundTags(text) {
  return String(text || '').replace(/^\s*(\[[^\]]*\]|\(music\)|music\b)\s*/i, '').trim();
}

// Client and server both use this rule: is the reply a "no question" reply?
export function isNoneReply(text) {
  return /^\s*NONE\b/i.test(String(text || ''));
}

// ---------- study chat ----------

export const CHAT_LENGTHS = {
  concise: 'Be concise: at most about 120 words.',
  standard: 'Aim for about 150-300 words unless the question needs less.',
  detailed: 'Give a thorough answer, up to about 700 words, with structure (short headings or lists) where it helps.',
};

const CHAT_SYSTEM = `You are an expert RICS APC tutor and study assistant for a candidate on the Quantity Surveying and Construction pathway.
You help them prepare for the APC final interview: explain RICS standards and competencies, check their understanding, quiz them, and help them talk about their own experience and case study.

Sources:
- You receive numbered excerpts from the candidate's documents: the shared RICS competency library and their own private case study. Each excerpt starts with [n] and its document name.
- Use the excerpts first. After every sentence or bullet that uses an excerpt, cite it with its number in square brackets, e.g. [2] or [1][3]. Only cite numbers that exist. Never put citations in headings.
- If the excerpts do not cover the question, say so briefly and answer from general RICS knowledge, without citations.
- For the candidate's own experience, projects, figures and case study, use ONLY their notes and case study excerpts. Never invent projects, figures, dates or names.

Accuracy:
- Never guess. Every fact, clause number, standard name, edition, figure and date must be correct. If unsure of a detail, leave it out and state the principle.
- Use the candidate's region from their profile or notes (e.g. GCC: FIDIC, POMI); otherwise UK practice.

Style:
- Plain, friendly British English. Markdown: short paragraphs, "- " bullet lists, "1." numbered lists, **bold** for key terms, and a simple table when comparing things. Use "###" headings only for long answers.
- When asked to quiz or test, ask one question at a time and wait for the answer, then give feedback with a model answer.`;

// Voice mode: every reply is read aloud
export const VOICE_STYLE = `Voice conversation: your reply is read aloud by text-to-speech and the candidate replies by speaking.
- Talk naturally in short spoken sentences: usually 2-5 sentences (about 40-100 words), unless they ask for more detail.
- No headings, tables, bullet lists or other Markdown. Say lists in a sentence ("first…, second…").
- Write numbers and abbreviations the way they are said where it helps (e.g. "NRM 2", "five per cent").
- Still cite excerpts with [n] after a sentence: citations are shown on screen and not read aloud.`;

// Mock interview: the assistant plays the assessment panel. focus: a plain-English description of what to cover.
export const MOCK_SYSTEM = `You are the chair of the assessment panel in a MOCK RICS APC final interview (Quantity Surveying and Construction pathway). Run a realistic practice interview with the candidate.

How to run it:
- Ask ONE question at a time, then stop and wait for the answer.
- Mix the question types a real panel uses: questions on the candidate's case study, technical competencies at all three levels (Level 1 knowing, Level 2 doing, Level 3 advising, e.g. "What would you advise your client if…?"), mandatory competencies, and ethics / Rules of Conduct scenarios.
- After each answer: give brief feedback in 1-3 sentences (what was good, and what was missing or wrong, specifically), then either probe with a follow-up when the answer was vague or move to the next question. Do not lecture.
- Base case study questions ONLY on the candidate's notes and case study excerpts. Never invent their project facts, figures or names. If you have none, ask them to describe their project.
- When you correct a technical point, use the excerpts and cite them with [n]; never guess facts, clause numbers or figures.
- Be professional, polite and realistic, like a real panel member. Use British English.
- If the candidate says they want to finish (e.g. "end the interview", "finish", "how did I do?"), stop asking and give a short summary: strengths, areas to improve (by competency), and an overall view: "Likely pass", "Borderline" or "Needs more preparation", with the main reason.
- When the message is exactly "[Start the mock interview]": greet the candidate briefly, explain the format in one sentence, and ask the first question (for example, a short overview of their role or case study).`;

// excerpts: [{ n, label, text }]; history: [{ role, content }] oldest first
// mode: 'chat' (tutor) or 'mock' (mock interview); voice: replies are spoken; focus: mock interview focus
export function buildChatMessages({ profile = '', notes = '', excerpts = [], history = [], question, length = 'standard', mode = 'chat', voice = false, focus = '' }) {
  const context = [];
  if (profile) context.push(`About the candidate: ${profile}`);
  if (notes) context.push(`Candidate's notes:\n"""\n${notes}\n"""`);
  context.push(excerpts.length
    ? `Excerpts for this question:\n\n${excerpts.map((e) => `[${e.n}] ${e.label}\n${e.text}`).join('\n\n')}`
    : 'No document excerpts matched this question.');
  return [
    {
      role: 'system',
      content: [
        mode === 'mock' ? MOCK_SYSTEM : CHAT_SYSTEM,
        mode === 'mock' ? `Focus of this mock interview: ${focus || 'a balanced mix of case study, technical, mandatory and ethics questions'}.` : '',
        voice ? VOICE_STYLE : mode === 'mock' ? 'Keep each turn short: feedback in 1-3 sentences, then one question.' : `Length: ${CHAT_LENGTHS[length] || CHAT_LENGTHS.standard}`,
        context.join('\n\n'),
      ].filter(Boolean).join('\n\n'),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];
}
