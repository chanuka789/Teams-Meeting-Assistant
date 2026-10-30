// Small, safe Markdown parser for chat answers. Produces a tree (no HTML strings), so the page builds DOM
// nodes with text only. Supports headings, paragraphs, lists, tables, quotes, code, bold/italic/code
// and citation markers like [2] or [1][3]. Pure and unit tested.

// Inline text -> [{ t: 'text'|'b'|'i'|'code'|'cite', v }]
export function parseInline(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[2] || m[3]) out.push({ t: 'b', v: m[2] || m[3] });
    else if (m[4]) out.push({ t: 'code', v: m[4] });
    else if (m[5] || m[6]) out.push({ t: 'i', v: m[5] || m[6] });
    else if (m[7]) for (const n of m[7].split(',')) out.push({ t: 'cite', v: Number(n.trim()) });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Markdown -> blocks: { type: 'h', level, inline } | { type: 'p', inline } | { type: 'ul'|'ol', items: [inline] }
// | { type: 'table', head: [inline], rows: [[inline]] } | { type: 'quote', inline } | { type: 'code', text }
export function parseMarkdown(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const hm = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (hm) { flush(); blocks.push({ type: 'h', level: Math.min(hm[1].length, 3), inline: parseInline(hm[2]) }); continue; }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line).map(parseInline);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(cells(lines[i]).map(parseInline));
      i--;
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const type = ul ? 'ul' : 'ol';
      const prev = blocks[blocks.length - 1];
      const item = parseInline((ul || ol)[1]);
      if (prev?.type === type && prev.open) prev.items.push(item); else blocks.push({ type, items: [item], open: true });
      continue;
    }
    if (/^\s*>/.test(line)) { flush(); blocks.push({ type: 'quote', inline: parseInline(line.replace(/^\s*>\s?/, '')) }); continue; }
    // A plain line right after a list continues the last item
    const prev = blocks[blocks.length - 1];
    if (!para.length && (prev?.type === 'ul' || prev?.type === 'ol') && prev.open && /^\s{2,}/.test(line)) {
      prev.items[prev.items.length - 1].push({ t: 'text', v: ` ${line.trim()}` });
      continue;
    }
    if (prev) prev.open = prev.type === 'ul' || prev.type === 'ol' ? prev.open : false;
    para.push(line.trim());
  }
  flush();
  for (const b of blocks) delete b.open;
  return blocks;
}

// Citation numbers used in a text, in order of first use
export function citedNumbers(md) {
  const seen = [];
  for (const b of parseInline(String(md).replace(/\n/g, ' '))) if (b.t === 'cite' && !seen.includes(b.v)) seen.push(b.v);
  return seen;
}
