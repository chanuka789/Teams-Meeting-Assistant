// Accounts and sessions: scrypt password hashes, random session tokens in an HttpOnly cookie
// (only a SHA-256 of the token is stored).

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
export const COOKIE = 'tma_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export function normaliseUsername(username) {
  return String(username || '').trim().toLowerCase();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId]);
  await q('update users set last_login_at = now() where id = $1', [userId]);
  return token;
}

export async function deleteSession(token) {
  if (token) await q('delete from sessions where token_hash = $1', [sha256(token)]);
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const PUBLIC_USER = 'u.id, u.username, u.name, u.role, u.profile, u.notes, u.prefs, u.created_at, u.last_login_at';

// Express middleware: attaches req.user when the session cookie is valid
export async function loadUser(req, res, next) {
  const token = readCookie(req, COOKIE);
  req.sessionToken = token;
  if (!token) return next();
  try {
    const { rows } = await q(
      `select ${PUBLIC_USER} from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
    req.user = rows[0] || null;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can do this.' });
  next();
}
