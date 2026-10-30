// Documents: store the file in the bucket, the text as searchable chunks in Postgres, and find the
// passages most relevant to a question (library shared by everyone + the user's own case study).

import crypto from 'node:crypto';
import { q, pool } from './db.js';
import { putFile, deleteFile } from './storage.js';
import { extractText, mimeFor } from './extract.js';
import { chunkText, tokenize } from './knowledge.js';

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
      `insert into documents (scope, competency_id, owner_id, name, mime, size, storage_key, chars, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [scope, competencyId, ownerId, name, mimeFor(name), buffer.length, key, text.length, uploadedBy]);
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
    `select c.text, d.name as doc, d.scope, comp.name as competency, ts_rank_cd(c.tsv, query) as score
       from chunks c
       join documents d on d.id = c.document_id
       left join competencies comp on comp.id = d.competency_id,
       to_tsquery('english', $1) query
      where c.tsv @@ query and ${where}
      order by score desc
      limit ${limit}`, [tsquery, ...params]);
  return rows;
}

// Most relevant passages for a question: up to 4 from the user's case study, up to 5 from the library
export async function searchKnowledge(userId, question, maxChars = 7000) {
  const tsquery = orQuery(question);
  if (!tsquery) return [];
  const [caseStudy, library] = await Promise.all([
    topChunks(`d.scope = 'case_study' and d.owner_id = $2`, [userId], tsquery, 4),
    topChunks(`d.scope = 'library'`, [], tsquery, 5),
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
