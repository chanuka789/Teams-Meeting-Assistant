// Documents: store the file in the bucket, the text as searchable chunks in Postgres, and find the
// passages most relevant to a question (library shared by everyone + the user's own case study).

import crypto from 'node:crypto';
import { q, pool } from './db.js';
import { putFile, deleteFile, getFileStream } from './storage.js';
import { extractText, mimeFor } from './extract.js';
import { chunkText, tokenize, locateChunks, mergeChunks } from './knowledge.js';

const safeName = (name) => String(name).replace(/[^\w.() -]+/g, '_').slice(-120);

export async function addDocument({ scope, competencyId = null, ownerId = null, name, buffer, uploadedBy }) {
  const text = await extractText(name, buffer); // throws for unsupported / unreadable files
  const key = `${scope === 'library' ? `library/${competencyId ?? 'general'}` : `case-study/${ownerId}`}/`
    + `${crypto.randomUUID()}-${safeName(name)}`;
  await putFile(key, buffer, mimeFor(name));
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into documents (scope, competency_id, owner_id, name, mime, size, storage_key, chars, uploaded_by, text)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [scope, competencyId, ownerId, name, mimeFor(name), buffer.length, key, text.length, uploadedBy, text]);
    const id = rows[0].id;
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i += 200) {
      const batch = chunks.slice(i, i + 200);
      const values = batch.map((_, j) => `($1, $${j * 2 + 2}, $${j * 2 + 3})`).join(', ');
      await client.query(`insert into chunks (document_id, idx, text) values ${values}`,
        [id, ...batch.flatMap((c, j) => [i + j, c])]);
    }
    await client.query('commit');
    return { id, chars: text.length, chunks: chunks.length, empty: !text };
  } catch (err) {
    await client.query('rollback');
    await deleteFile(key).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function removeDocument(doc) {
  await q('delete from documents where id = $1', [doc.id]);
  await deleteFile(doc.storage_key).catch((err) => console.error('[storage] delete failed', err.message));
}

// "a | b | c" for to_tsquery, from the question's keywords (letters/digits only, so it always parses)
export function orQuery(question) {
  const terms = [...new Set(tokenize(question).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length > 1 || /\d/.test(t)))];
  return terms.slice(0, 30).join(' | ');
}

async function topChunks(where, params, tsquery, limit) {
  const { rows } = await q(
    `select c.id as chunk_id, d.id as document_id, c.text, d.name as doc, d.scope, comp.name as competency,
            ts_rank_cd(c.tsv, query) as score
       from chunks c
       join documents d on d.id = c.document_id
       left join competencies comp on comp.id = d.competency_id,
       to_tsquery('english', $1) query
      where c.tsv @@ query and ${where}
      order by score desc
      limit ${limit}`, [tsquery, ...params]);
  return rows;
}

// Passage counts for case study and library. route (from the decision model, optional):
// { source: 'case_study' | 'library' | 'both' | null, competencyId } shifts the balance, never to zero.
export function routedCounts(route, caseN, libN) {
  const total = caseN + libN;
  if (route?.source === 'case_study') return [Math.round(total * 0.65), total - Math.round(total * 0.65)];
  if (route?.source === 'library') return [Math.round(total * 0.25), total - Math.round(total * 0.25)];
  return [caseN, libN];
}

// Library passages; with a likely competency, its documents come first, then the best of the rest
async function libraryChunks(tsquery, limit, competencyId) {
  if (!competencyId) return topChunks(`d.scope = 'library'`, [], tsquery, limit);
  const [comp, all] = await Promise.all([
    topChunks(`d.scope = 'library' and d.competency_id = $2`, [competencyId], tsquery, Math.ceil(limit * 0.6)),
    topChunks(`d.scope = 'library'`, [], tsquery, limit),
  ]);
  const seen = new Set(comp.map((r) => String(r.chunk_id)));
  return [...comp, ...all.filter((r) => !seen.has(String(r.chunk_id)))].slice(0, limit);
}

// Most relevant passages for a question: up to 4 from the user's case study, up to 5 from the library
export async function searchKnowledge(userId, question, maxChars = 7000, route = null) {
  const tsquery = orQuery(question);
  if (!tsquery) return [];
  const [caseN, libN] = routedCounts(route, 4, 5);
  const [caseStudy, library] = await Promise.all([
    topChunks(`d.scope = 'case_study' and d.owner_id = $2`, [userId], tsquery, caseN),
    libraryChunks(tsquery, libN, route?.competencyId),
  ]);
  const out = [];
  let total = 0;
  // Interleave so both sources are represented before the character limit is reached
  for (let i = 0; i < Math.max(caseStudy.length, library.length); i++) {
    for (const row of [caseStudy[i], library[i]]) {
      if (!row || total + row.text.length > maxChars) continue;
      out.push(row);
      total += row.text.length;
    }
  }
  return out;
}

// Passages for a chat question. scope: 'all' | 'library' | 'case_study' | 'competency:<id>'
export async function searchForChat(userId, question, scope = 'all', maxChars = 9000, route = null) {
  const tsquery = orQuery(question);
  if (!tsquery) return [];
  let rows;
  if (scope === 'library') rows = await topChunks(`d.scope = 'library'`, [], tsquery, 8);
  else if (scope === 'case_study') rows = await topChunks(`d.scope = 'case_study' and d.owner_id = $2`, [userId], tsquery, 8);
  else if (/^competency:\d+$/.test(scope)) {
    rows = await topChunks(`d.scope = 'library' and d.competency_id = $2`, [Number(scope.split(':')[1])], tsquery, 8);
  } else {
    const [caseN, libN] = routedCounts(route, 4, 6);
    const [caseStudy, library] = await Promise.all([
      topChunks(`d.scope = 'case_study' and d.owner_id = $2`, [userId], tsquery, caseN),
      libraryChunks(tsquery, libN, route?.competencyId),
    ]);
    rows = [];
    for (let i = 0; i < Math.max(caseStudy.length, library.length); i++) rows.push(...[caseStudy[i], library[i]].filter(Boolean));
  }
  const out = [];
  let total = 0;
  for (const row of rows) {
    if (total + row.text.length > maxChars) continue;
    out.push(row);
    total += row.text.length;
  }
  return out;
}

async function readAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

// Full text of a document plus the character ranges of the given chunks, for the chat document viewer
export async function documentView(doc, chunkIds = []) {
  const { rows: chunks } = await q('select id, idx, text from chunks where document_id = $1 order by idx', [doc.id]);
  const text = doc.text ?? mergeChunks(chunks.map((c) => c.text));
  const wanted = new Set(chunkIds.map(Number));
  // Chunk ids are bigints, which pg returns as strings: send numbers
  return { text, ranges: locateChunks(text, chunks.filter((c) => wanted.has(Number(c.id))).map((c) => ({ ...c, id: Number(c.id) }))) };
}

// Documents uploaded before full text was stored: read the original file from the bucket once and save its text
export async function backfillDocumentText() {
  const { rows } = await q('select id, name, storage_key from documents where text is null order by id');
  let done = 0;
  for (const d of rows) {
    try {
      const text = await extractText(d.name, await readAll(await getFileStream(d.storage_key)));
      await q('update documents set text = $2 where id = $1', [d.id, text]);
      done++;
    } catch (err) {
      console.error('[backfill]', d.name, err.message); // the viewer falls back to text rebuilt from chunks
    }
  }
  if (rows.length) console.log(`[backfill] stored full text for ${done} of ${rows.length} documents`);
}
