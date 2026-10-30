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
  { id: 'points', label: 'Points only', hint: '4–6 short bullet points' },
  { id: 'brief', label: 'Short description only', hint: '2–3 sentences, no bullets' },
  { id: 'balanced', label: 'Description + 3–4 points', hint: '1–2 sentences, then 3–4 points' },
  { id: 'detailed', label: 'Detailed', hint: '2 sentences, then 5–6 points' },
];
export const DEFAULT_ANSWER_STYLE = 'balanced';
