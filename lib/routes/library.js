// Competency library (shared, admins upload) and case study documents (private to each user)

import express from 'express';
import { pipeline } from 'node:stream/promises';
import { q } from '../db.js';
import { requireUser, requireAdmin } from '../auth.js';
import { addDocument, removeDocument, documentView } from '../documents.js';
import { getFileStream } from '../storage.js';
import { docKind, MAX_DOC_BYTES, UNSUPPORTED_MSG } from '../extract.js';

export const router = express.Router();
router.use(requireUser);

const CATEGORIES = ['mandatory', 'core', 'optional', 'general'];

// ---------- competencies ----------

router.get('/competencies', async (req, res) => {
  const { rows } = await q(
    `select c.id, c.name, c.category, c.level, c.sort,
            (select count(*)::int from documents d where d.scope = 'library' and d.competency_id = c.id) as docs
       from competencies c order by c.sort, c.id`);
  res.json(rows);
});

router.post('/competencies', requireAdmin, async (req, res) => {
  const { name = '', category = 'optional', level = null } = req.body || {};
  if (!String(name).trim()) return res.status(400).json({ error: 'Enter a competency name.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category.' });
  const lvl = level === null || level === '' ? null : Number(level);
  if (lvl !== null && ![1, 2, 3].includes(lvl)) return res.status(400).json({ error: 'Level must be 1, 2 or 3.' });
  const { rows } = await q(
    `insert into competencies (name, category, level, sort)
     values ($1, $2, $3, (select coalesce(max(sort), 0) + 1 from competencies)) returning id`,
    [String(name).trim().slice(0, 150), category, lvl]);
  res.json({ id: rows[0].id });
});

router.patch('/competencies/:id', requireAdmin, async (req, res) => {
  const { name, category, level } = req.body || {};
  const id = Number(req.params.id);
  if (category !== undefined && !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category.' });
  const lvl = level === undefined ? undefined : level === null || level === '' ? null : Number(level);
  if (lvl !== undefined && lvl !== null && ![1, 2, 3].includes(lvl)) return res.status(400).json({ error: 'Level must be 1, 2 or 3.' });
  const { rowCount } = await q(
    `update competencies set
       name = coalesce($2, name), category = coalesce($3, category),
       level = case when $4::boolean then $5::smallint else level end
     where id = $1`,
    [id, typeof name === 'string' && name.trim() ? name.trim().slice(0, 150) : null, category ?? null,
      lvl !== undefined, lvl ?? null]);
  if (!rowCount) return res.status(404).json({ error: 'Competency not found.' });
  res.json({ ok: true });
});

router.delete('/competencies/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(`select count(*)::int as n from documents where competency_id = $1`, [id]);
  if (rows[0].n > 0) return res.status(400).json({ error: 'Move or delete the documents in this competency first.' });
  await q('delete from competencies where id = $1', [id]);
  res.json({ ok: true });
});

// ---------- documents ----------

const docJson = (d) => ({
  id: d.id, scope: d.scope, competencyId: d.competency_id, name: d.name, size: d.size, chars: d.chars,
  createdAt: d.created_at, uploadedBy: d.uploaded_by_name || null,
});

// ?scope=library[&competencyId=] (everyone) or ?scope=case_study (own documents only)
router.get('/documents', async (req, res) => {
  const scope = req.query.scope === 'case_study' ? 'case_study' : 'library';
  const params = [];
  let where = `d.scope = '${scope}'`;
  if (scope === 'case_study') { params.push(req.user.id); where += ` and d.owner_id = $${params.length}`; }
  if (scope === 'library' && req.query.competencyId) {
    params.push(Number(req.query.competencyId));
    where += ` and d.competency_id = $${params.length}`;
  }
  const { rows } = await q(
    `select d.*, u.name as uploaded_by_name from documents d left join users u on u.id = d.uploaded_by
      where ${where} order by d.created_at desc`, params);
  res.json(rows.map(docJson));
});

// Upload: raw file body, ?scope=library&competencyId=3&name=file.pdf  or  ?scope=case_study&name=file.pdf
router.post('/documents', express.raw({ type: () => true, limit: MAX_DOC_BYTES }), async (req, res) => {
  const scope = req.query.scope === 'case_study' ? 'case_study' : 'library';
  const name = String(req.query.name || '').trim().slice(0, 200);
  if (scope === 'library' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can add library documents.' });
  if (!name || !docKind(name)) return res.status(400).json({ error: UNSUPPORTED_MSG });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  let competencyId = null;
  if (scope === 'library') {
    competencyId = Number(req.query.competencyId) || null;
    const { rows } = await q('select id from competencies where id = $1', [competencyId]);
    if (!rows[0]) return res.status(400).json({ error: 'Choose a competency for this document.' });
  }
  try {
    const out = await addDocument({
      scope, competencyId, ownerId: scope === 'case_study' ? req.user.id : null,
      name, buffer: req.body, uploadedBy: req.user.id,
    });
    res.json({ ...out, warning: out.empty ? 'No text found in this file (scanned PDF or images only), so it cannot be used for answers.' : null });
  } catch (err) {
    console.error('[upload]', name, err.message);
    res.status(422).json({ error: `Could not read ${name}: ${err.message}` });
  }
});

async function findDoc(req, res) {
  const { rows } = await q('select * from documents where id = $1', [Number(req.params.id)]);
  const d = rows[0];
  const allowed = d && (d.scope === 'library' || d.owner_id === req.user.id);
  if (!allowed) { res.status(404).json({ error: 'Document not found.' }); return null; }
  return d;
}

const canChange = (req, d) => (d.scope === 'library' ? req.user.role === 'admin' : d.owner_id === req.user.id);

router.get('/documents/:id/file', async (req, res) => {
  const d = await findDoc(req, res);
  if (!d) return;
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.name)}`);
  await pipeline(await getFileStream(d.storage_key), res);
});

// Text of a document and the positions of the given chunks (?chunks=1,2), for the chat document viewer
router.get('/documents/:id/view', async (req, res) => {
  const d = await findDoc(req, res);
  if (!d) return;
  const chunkIds = String(req.query.chunks || '').split(',').map(Number).filter(Number.isFinite).slice(0, 50);
  const { text, ranges } = await documentView(d, chunkIds);
  const { rows } = await q('select name from competencies where id = $1', [d.competency_id]);
  res.json({ id: d.id, name: d.name, scope: d.scope, competency: rows[0]?.name || null, text, ranges });
});

// Move a library document to another competency
router.patch('/documents/:id', async (req, res) => {
  const d = await findDoc(req, res);
  if (!d) return;
  if (!canChange(req, d) || d.scope !== 'library') return res.status(403).json({ error: 'Not allowed.' });
  const competencyId = Number(req.body?.competencyId);
  const { rows } = await q('select id from competencies where id = $1', [competencyId]);
  if (!rows[0]) return res.status(400).json({ error: 'Unknown competency.' });
  await q('update documents set competency_id = $2 where id = $1', [d.id, competencyId]);
  res.json({ ok: true });
});

router.delete('/documents/:id', async (req, res) => {
  const d = await findDoc(req, res);
  if (!d) return;
  if (!canChange(req, d)) return res.status(403).json({ error: 'Only an admin can delete library documents.' });
  await removeDocument(d);
  res.json({ ok: true });
});
