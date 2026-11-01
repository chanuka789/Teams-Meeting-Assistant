// Answer text format shared by the answer cards and the floating window (pure, unit tested)

// "Q: …\nA:\n<description>\n- point" -> { question, blocks: [{ type: 'p'|'ul', text|items }] }
export function parseAnswer(text) {
  const m = String(text).match(/^\s*Q:\s*(.*?)\s*(?:\n+\s*A:\s*([\s\S]*))?$/i);
  const body = (m ? m[2] || '' : text).trim();
  const blocks = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const point = line.match(/^[-•*]\s*(.*)$/);
    if (point) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(point[1]); else blocks.push({ type: 'ul', items: [point[1]] });
    } else {
      blocks.push({ type: 'p', text: line });
    }
  }
  return { question: m?.[1] || '', blocks };
}

// Answer styles the user can choose (prompt rules per style live in lib/prompt.js)
export const ANSWER_STYLES = [
  { id: 'points', label: 'Points only', short: 'Style: Points only', hint: '4–6 short bullet points' },
  { id: 'brief', label: 'Short description only', short: 'Style: Short description', hint: '2–3 sentences, no bullets' },
  { id: 'balanced', label: 'Description + 3–4 points', short: 'Style: Description + points', hint: '1–2 sentences, then 3–4 points' },
  { id: 'detailed', label: 'Detailed', short: 'Style: Detailed', hint: '2 sentences, then 5–6 points' },
];
export const DEFAULT_ANSWER_STYLE = 'balanced';

// ---------- repeated questions (shared by /api/detect and the Live page) ----------

const QUESTION_STOPWORDS = new Set(('a an the and or of to in on for with at by from is are was were be been it its this that these those '
  + 'what which who whom how why when where do does did can could would should will shall may might must you your yours '
  + 'we us our i me my please tell explain describe talk through about us give some me just so then also there their they '
  + 'have has had any us mean meant understand know').split(' '));

// Content words of a question, lower-case, without filler words ("Can you explain…", "Tell us about…")
export function questionWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !QUESTION_STOPWORDS.has(w)));
}

// Is `question` the same as one already answered? (Dice overlap of content words >= 0.8)
// "What is the RIBA Plan of Work?" ~ "Can you explain the RIBA Plan of Work?" -> repeat;
// "What is NRM 2?" vs "How did you use NRM 2 on your project?" -> new question.
export function isRepeatQuestion(question, answered = []) {
  const a = questionWords(question);
  if (!a.size) return false;
  return answered.some((prev) => {
    const b = questionWords(prev);
    if (!b.size) return false;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    return (2 * common) / (a.size + b.size) >= 0.8;
  });
}
