// Voice mode text helpers: turn streamed Markdown into speakable sentences.
// Pure functions with no browser APIs, so they can be unit tested in Node.

// Markdown answer -> plain text for the voice: no citations, symbols, headings, tables or links.
// final=false while the answer is still streaming: the unfinished last line gets no full stop yet,
// so text already spoken (complete sentences) never changes as more arrives.
export function speakable(md, final = true) {
  const lines = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')             // table rows
    .replace(/\[(\d+)\](?!\()/g, '')               // citations [1]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links -> their text
    .replace(/^#{1,6}\s+(.*)$/gm, '$1.')           // headings become short sentences
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')     // list markers
    .replace(/[*_`~>]+/g, '')                      // emphasis, code, quotes
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\.{2,}(?!\.)/g, '.')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim());
  const lastOpen = !final && !/\n\s*$/.test(String(md || ''));
  return lines
    .map((l, i) => {
      if (!/[a-z0-9]/i.test(l)) return '';
      // Each line (a list item, a heading) is spoken as its own sentence
      return /[.!?:;]$/.test(l) || (lastOpen && i === lines.length - 1) ? l : `${l}.`;
    })
    .filter(Boolean)
    .join('\n');
}

// Splits speakable text into chunks for text-to-speech. Returns { chunks, rest }: complete chunks, and the
// unfinished tail to keep until more text arrives. With final=true the tail is returned as a chunk too.
// A chunk ends at a sentence end or line break; very short sentences are joined to the next one.
export function takeChunks(text, final = false, minChars = 40, maxChars = 320) {
  const chunks = [];
  let rest = String(text || '');
  const re = /[.!?](?=\s|$)|\n/g;
  for (;;) {
    re.lastIndex = 0;
    let cut = -1;
    let m;
    while ((m = re.exec(rest))) {
      const end = m.index + 1;
      // A sentence end only counts once more text follows it (or the stream has finished)
      if (end >= rest.length && !final) break;
      if (end >= minChars || end >= rest.length) { cut = end; break; }
    }
    if (cut === -1 && rest.length > maxChars) {
      // A very long sentence: cut at the last comma or space before the limit
      const slice = rest.slice(0, maxChars);
      cut = Math.max(slice.lastIndexOf(', ') + 1, slice.lastIndexOf(' '));
      if (cut <= 0) cut = maxChars;
    }
    if (cut === -1) break;
    const chunk = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (chunk) chunks.push(chunk);
  }
  if (final && rest.trim()) { chunks.push(rest.trim()); rest = ''; }
  return { chunks, rest };
}
