// Text helpers for document search: keyword tokens (for the Postgres full-text query) and chunking.

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in
into is it its me my of on or our so than that the their them then there these they this to was we were what when
where which who why will with would you your about tell us talk through explain describe please give`.split(/\s+/));

export function tokenize(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9.%]+/g, ' ')
    .split(' ')
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)); // crude plural folding
}

// Split text into ~size-character chunks on paragraph / sentence boundaries, with a little overlap
export function chunkText(text, size = 900, overlap = 150) {
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > size) {
      chunks.push(cur);
      cur = cur.slice(-overlap).replace(/^\S*\s/, ''); // start next chunk with the tail of this one
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// ---------- locating cited passages in a document's full text ----------

// Text with every whitespace run collapsed to one space, plus a map from each normalised index to the original index
export function normalizeWithMap(text) {
  let norm = '';
  const map = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!space) { norm += ' '; map.push(i); space = true; }
    } else {
      norm += text[i];
      map.push(i);
      space = false;
    }
  }
  return { norm, map };
}

// [{ id, text }] chunks -> [{ id, start, end }] character ranges in `text` (chunks not found are left out).
// Chunks are sentences joined by single spaces, so they appear exactly in the whitespace-normalised text.
export function locateChunks(text, chunks) {
  const { norm, map } = normalizeWithMap(text);
  const out = [];
  for (const c of chunks) {
    const needle = String(c.text).replace(/\s+/g, ' ').trim();
    if (!needle) continue;
    let pos = norm.indexOf(needle);
    let len = needle.length;
    if (pos < 0) { // fall back to the opening words if the passage differs slightly
      len = Math.min(120, needle.length);
      pos = norm.indexOf(needle.slice(0, len));
    }
    if (pos < 0) continue;
    out.push({ id: c.id, start: map[pos], end: map[pos + len - 1] + 1 });
  }
  return out;
}

// Rebuild a document's text from its overlapping chunks (for documents uploaded before full text was stored)
export function mergeChunks(chunks) {
  let acc = '';
  for (const c of chunks) {
    if (!acc) { acc = c; continue; }
    let k = Math.min(c.length, 300);
    while (k > 0 && !acc.endsWith(c.slice(0, k))) k--;
    acc += k > 0 ? c.slice(k) : `\n\n${c}`;
  }
  return acc;
}
