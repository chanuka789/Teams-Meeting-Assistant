// Knowledge search over the user's documents: chunking + BM25 keyword ranking.
// Pure (no browser APIs), shared by the browser and unit tests.

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

// docs: [{ name, text }] -> index used by search()
export function buildIndex(docs) {
  const chunks = [];
  for (const d of docs) {
    for (const text of chunkText(d.text)) {
      const terms = tokenize(text);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      chunks.push({ doc: d.name, text, tf, len: terms.length });
    }
  }
  const df = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = chunks.reduce((n, c) => n + c.len, 0) / (chunks.length || 1);
  return { chunks, df, avgLen };
}

// Top chunks for a query (BM25), limited to maxChars in total
export function search(index, query, { k = 6, maxChars = 6000 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.chunks.length) return [];
  const N = index.chunks.length;
  const k1 = 1.4, b = 0.75;
  const scored = [];
  for (const c of index.chunks) {
    let score = 0;
    for (const t of terms) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / index.avgLen));
    }
    if (score > 0) scored.push({ doc: c.doc, text: c.text, score });
  }
  scored.sort((x, y) => y.score - x.score);
  const out = [];
  let total = 0;
  for (const s of scored.slice(0, k)) {
    if (total + s.text.length > maxChars) break;
    out.push(s);
    total += s.text.length;
  }
  return out;
}
