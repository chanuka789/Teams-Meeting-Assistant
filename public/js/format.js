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
