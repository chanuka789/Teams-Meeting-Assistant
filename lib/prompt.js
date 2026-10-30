// Prompt building and transcript clean-up helpers (kept separate so they can be unit tested)

export const SYSTEM_PROMPT = `You are a live meeting assistant. The user is in an online meeting (MS Teams).
You only hear the OTHER participants, never the user.
Your job: when another participant asks the user a question or asks for information, give the user a short answer they can say out loud right away.

Rules:
- If the latest speech has no question or request the user should respond to (small talk, statements, people talking to each other, filler), reply with exactly: NONE
- Otherwise reply in this exact format:
Q: <the question, rephrased in under 15 words>
A: <answer in 1-4 short bullet points starting with "- ", plain spoken English, easy to read quickly>
- Use the user's notes and the meeting transcript first. If the answer depends on a figure, date or fact that is NOT in the notes or transcript, do not invent it: say what to check or offer a safe holding answer (for example "I'll confirm the exact figure after the meeting").
- Keep it short. No preamble, no markdown headings.`;

export function buildAnswerMessages({ latest, transcript, notes, role, manual }) {
  const parts = [];
  if (role) parts.push(`About the user: ${role}`);
  if (notes) parts.push(`User's notes / project context:\n"""\n${notes}\n"""`);
  if (transcript) parts.push(`Recent meeting transcript (other participants only, oldest first):\n"""\n${transcript}\n"""`);
  if (manual) {
    parts.push(`The user typed this question and wants an answer (always answer, never reply NONE):\n"""\n${latest}\n"""`);
  } else {
    parts.push(`Latest speech from other participants:\n"""\n${latest}\n"""`);
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
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
  return false;
}

// Client and server both use this rule: is the reply a "no question" reply?
export function isNoneReply(text) {
  return /^\s*NONE\b/i.test(String(text || ''));
}
