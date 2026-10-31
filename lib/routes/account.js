// Accounts: first-admin setup, sign in/out, own profile and preferences, admin user management

import express from 'express';
import crypto from 'node:crypto';
import { q } from '../db.js';
import {
  hashPassword, verifyPassword, passwordProblem, normaliseUsername, createSession, deleteSession,
  setSessionCookie, requireUser, requireAdmin, COOKIE, PUBLIC_USER,
} from '../auth.js';
import { usageTotals } from '../openrouter.js';
import { ANSWER_STYLES } from '../../public/js/format.js';

export const router = express.Router();

// Preferences a user may store, with validation
const PREFS = {
  answerModel: (v) => typeof v === 'string' && v.length <= 200,
  sttModel: (v) => typeof v === 'string' && v.length <= 200,
  detectModel: (v) => typeof v === 'string' && v.length <= 200,
  reasoning: (v) => typeof v === 'string' && v.length <= 20,
  autoAnswer: (v) => typeof v === 'boolean',
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  answerSize: (v) => Number.isInteger(v) && v >= 12 && v <= 36,
  transcriptSize: (v) => Number.isInteger(v) && v >= 11 && v <= 30,
  overlaySize: (v) => Number.isInteger(v) && v >= 14 && v <= 48,
  answerStyle: (v) => ANSWER_STYLES.some((x) => x.id === v),
  chatModel: (v) => typeof v === 'string' && v.length <= 200,
  chatReasoning: (v) => typeof v === 'string' && v.length <= 20,
  chatLength: (v) => ['concise', 'standard', 'detailed'].includes(v),
  chatScope: (v) => typeof v === 'string' && /^(all|library|case_study|competency:\d+)$/.test(v),
  chatSize: (v) => Number.isInteger(v) && v >= 12 && v <= 24,
  chatListOpen: (v) => typeof v === 'boolean',
  sidebarCollapsed: (v) => typeof v === 'boolean',
  useDecisions: (v) => typeof v === 'boolean',
  voiceModel: (v) => typeof v === 'string' && v.length <= 200,
  voiceName: (v) => typeof v === 'string' && v.length <= 200,
  voiceInterrupt: (v) => typeof v === 'boolean',
  voiceAutoSend: (v) => typeof v === 'boolean',
  voiceSttModel: (v) => typeof v === 'string' && v.length <= 200,
  voiceChatModel: (v) => typeof v === 'string' && v.length <= 200,
  voiceReasoning: (v) => typeof v === 'string' && v.length <= 20,
  voicePause: (v) => ['short', 'normal', 'long'].includes(v),
  voiceLoudspeaker: (v) => typeof v === 'boolean',
  knowledgeSttModel: (v) => typeof v === 'string' && v.length <= 200,
  knowledgeModel: (v) => typeof v === 'string' && v.length <= 200,
};

export function cleanPrefs(input) {
  const out = {};
  for (const [k, ok] of Object.entries(PREFS)) {
    if (input && k in input && (input[k] === '' || input[k] === null || ok(input[k]))) out[k] = input[k];
  }
  return out;
}

const userJson = (u) => ({
  id: u.id, username: u.username, name: u.name, role: u.role,
  profile: u.profile, notes: u.notes, prefs: u.prefs || {},
  createdAt: u.created_at, lastLoginAt: u.last_login_at,
});

const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

const userCount = async () => (await q('select count(*)::int as n from users')).rows[0].n;

// Whether the app still needs its first admin, and whether a setup key is required
router.get('/setup', async (req, res) => {
  res.json({ needsSetup: (await userCount()) === 0, keyRequired: Boolean(process.env.APP_PASSWORD) });
});

// Create the first admin. Protected by the old APP_PASSWORD so a stranger cannot claim the app first.
router.post('/setup', async (req, res) => {
  if ((await userCount()) > 0) return res.status(409).json({ error: 'The app is already set up. Please sign in.' });
  const { setupKey = '', name = '', username = '', password = '' } = req.body || {};
  if (process.env.APP_PASSWORD && !safeEqual(setupKey, process.env.APP_PASSWORD)) {
    return res.status(403).json({ error: 'Setup key is not correct. Use the APP_PASSWORD from Railway.' });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!String(name).trim() || !normaliseUsername(username)) return res.status(400).json({ error: 'Enter your name and a username.' });
  const { rows } = await q(
    `insert into users (username, name, password_hash, role) values ($1, $2, $3, 'admin') returning id`,
    [normaliseUsername(username), String(name).trim().slice(0, 100), await hashPassword(password)]);
  setSessionCookie(req, res, await createSession(rows[0].id));
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const { rows } = await q('select id, password_hash from users where username = $1', [normaliseUsername(username)]);
  // Same work whether or not the user exists, so timing does not reveal usernames
  const ok = await verifyPassword(password, rows[0]?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86));
  if (!rows[0] || !ok) return res.status(401).json({ error: 'Wrong username or password.' });
  setSessionCookie(req, res, await createSession(rows[0].id));
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  await deleteSession(req.sessionToken);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json(userJson(req.user)));

router.patch('/me', requireUser, async (req, res) => {
  const { name, profile, notes, prefs } = req.body || {};
  const u = req.user;
  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : u.name,
    profile: typeof profile === 'string' ? profile.slice(0, 2000) : u.profile,
    notes: typeof notes === 'string' ? notes.slice(0, 100000) : u.notes,
    prefs: prefs ? { ...u.prefs, ...cleanPrefs(prefs) } : u.prefs,
  };
  const { rows } = await q(
    `update users u set name = $2, profile = $3, notes = $4, prefs = $5 where id = $1 returning ${PUBLIC_USER}`,
    [u.id, next.name, next.profile, next.notes, next.prefs]);
  res.json(userJson(rows[0]));
});

router.post('/me/password', requireUser, async (req, res) => {
  const { current = '', next = '' } = req.body || {};
  const { rows } = await q('select password_hash from users where id = $1', [req.user.id]);
  if (!(await verifyPassword(current, rows[0].password_hash))) return res.status(400).json({ error: 'Current password is not correct.' });
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  await q('update users set password_hash = $2 where id = $1', [req.user.id, await hashPassword(next)]);
  // Sign out other devices
  await q('delete from sessions where user_id = $1', [req.user.id]);
  setSessionCookie(req, res, await createSession(req.user.id));
  res.json({ ok: true });
});

router.get('/me/usage', requireUser, async (req, res) => {
  const totals = await usageTotals(req.user.id);
  // Audio knowledge files this user uploaded: how many and how many minutes (per period)
  const { rows } = await q(
    `select count(*)::int as all_n, coalesce(sum(duration_s), 0)::float as all_s,
            count(*) filter (where created_at >= date_trunc('month', now()))::int as month_n,
            coalesce(sum(duration_s) filter (where created_at >= date_trunc('month', now())), 0)::float as month_s
       from documents where source = 'audio' and uploaded_by = $1`, [req.user.id]);
  const a = rows[0];
  totals.month.audioFiles = a.month_n; totals.month.audioMinutes = Math.round(a.month_s / 60);
  totals.all.audioFiles = a.all_n; totals.all.audioMinutes = Math.round(a.all_s / 60);
  res.json(totals);
});

// ---------- admin: users ----------

router.get('/users', requireAdmin, async (req, res) => {
  const { rows } = await q(
    `select u.id, u.username, u.name, u.role, u.created_at, u.last_login_at,
            (select count(*)::int from documents d where d.scope = 'case_study' and d.owner_id = u.id) as case_docs
       from users u order by u.created_at`);
  const usage = await usageTotals();
  res.json(rows.map((u) => ({
    id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.created_at,
    lastLoginAt: u.last_login_at, caseStudyDocs: u.case_docs,
    usage: usage.get(u.id) || null,
  })));
});

router.post('/users', requireAdmin, async (req, res) => {
  const { name = '', username = '', password = '', role = 'user' } = req.body || {};
  const uname = normaliseUsername(username);
  if (!String(name).trim() || !uname) return res.status(400).json({ error: 'Enter a name and a username.' });
  if (!/^[a-z0-9._@-]{3,60}$/.test(uname)) {
    return res.status(400).json({ error: 'Username: 3-60 characters, letters, numbers and . _ @ - only.' });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  try {
    const { rows } = await q(
      'insert into users (username, name, password_hash, role) values ($1, $2, $3, $4) returning id',
      [uname, String(name).trim().slice(0, 100), await hashPassword(password), role]);
    res.json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    throw err;
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, role, password } = req.body || {};
  const { rows } = await q('select id, role from users where id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
  if (role && !['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (role === 'user' && rows[0].role === 'admin') {
    const admins = (await q(`select count(*)::int as n from users where role = 'admin'`)).rows[0].n;
    if (admins <= 1) return res.status(400).json({ error: 'There must be at least one admin.' });
  }
  if (typeof name === 'string' && name.trim()) await q('update users set name = $2 where id = $1', [id, name.trim().slice(0, 100)]);
  if (role) await q('update users set role = $2 where id = $1', [id, role]);
  if (password) {
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    await q('update users set password_hash = $2 where id = $1', [id, await hashPassword(password)]);
    await q('delete from sessions where user_id = $1', [id]);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  // Case study files go with the user (documents cascade); remove their stored files too
  const { rows: docs } = await q(`select id, storage_key from documents where owner_id = $1`, [id]);
  const { deleteFile } = await import('../storage.js');
  await q('delete from users where id = $1', [id]);
  for (const d of docs) await deleteFile(d.storage_key).catch(() => {});
  res.json({ ok: true });
});
