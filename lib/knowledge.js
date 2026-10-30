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
