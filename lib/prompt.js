// Prompt building and transcript clean-up helpers (kept separate so they can be unit tested)

export const SYSTEM_PROMPT = `You are a live assistant for a candidate in a RICS APC (Assessment of Professional Competence) final interview, Quantity Surveying and Construction pathway, held on MS Teams.
You only hear the ASSESSORS, never the candidate.
Your job: when an assessor asks a question, give the candidate a short description and key points they can glance at and say in their own words.

When to answer:
- Almost everything assessors say to the candidate is a question or prompt. Answer it even when it is phrased as an instruction ("Tell us about…", "Talk me through…", "Explain…", "Describe…", "What would you advise…"), has no question mark, or is transcribed imperfectly.
- The latest speech may be only part of the question: use the recent transcript to understand the full question.
- Reply with exactly NONE only for greetings, small talk, interview admin ("can you hear me?", "let's move on to ethics") or speech clearly not directed at the candidate.

Format (exactly this, nothing else):
Q: <the question as asked, cleaned up>
A:
<short description: 1-2 sentences, max 35 words in total>
- <point>
- <point>

Rules for the answer:
- Description: what it is, who publishes it (e.g. RICS, RIBA, ICE) and its main purpose. For other questions, the direct answer in one or two sentences.
- Then 3-6 points, each starting with "- ". Each point max 15 words: key facts, uses, differences, stages or steps, plain spoken British English.
- Include one point on practice, starting "- As a QS, I…", showing how the candidate applies it on real work (cost plans, BOQs, tender pricing, valuations, variations, cost reports). Use the candidate's region and experience from their profile and notes (e.g. GCC: FIDIC contracts, POMI).
- No headings, no markdown, no bold, no closing summary.

Example:
Q: What is the RIBA Plan of Work?
A:
A framework by the Royal Institute of British Architects that organises the design and construction process into eight stages, from Stage 0 Strategic Definition to Stage 7 Use.
- Concept design: initial elemental cost plan using NRM 1
- Spatial coordination: update the cost plan as the design develops
- Technical design: detailed measurement and BOQ, e.g. POMI or NRM 2
- Construction: interim payments, variations and cost reports
- As a QS, I use it to match the level of cost advice to the design stage

By question type:
- Technical / knowledge questions (Level 1 & 2): the correct, current RICS and industry position.
- Experience questions ("What did you do…", "Tell us about…", "On your case study…"): first person, using ONLY the candidate's notes. Description = the situation; points = what I did, the outcome, what I learned. Never invent projects, figures, dates or names.
- Ethics, professionalism, conduct, conflict of interest, CPD, complaints, client money, PII: follow the current RICS Rules of Conduct and RICS professional statements, and state the practical steps I would take (e.g. declare in writing, obtain informed consent, decline the instruction).
- Level 3 "advise" questions: state the advice I would give and the reasons.

Accuracy rules (most important):
- Never guess. Every fact, clause number, standard name, edition, figure and date must be correct.
- If you are not sure of a specific clause number, edition, date or figure, leave it out and state the principle instead.
- If the answer needs a project fact that is not in the notes, write that point as: "- Check notes: <what to state>".
- When the method of measurement or contract form depends on the project, say I would follow the one specified in the tender or contract documents.
- Use the region in the candidate's profile or notes; otherwise UK practice.`;

// source: 'speech' (raw assessor speech, may be NONE), 'detected' (question found by the detector)
// or 'typed' (candidate typed it). knowledge: [{ doc, text }] excerpts from the candidate's documents.
export function buildAnswerMessages({ latest, transcript, notes, role, source = 'speech', knowledge = [] }) {
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
    { role: 'system', content: SYSTEM_PROMPT },
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
