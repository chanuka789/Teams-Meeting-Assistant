// Signed-in user, saved preferences (stored on the server) and theme

import { api } from './api.js';

export const session = { me: null, models: null };

export const DEFAULT_PREFS = { autoAnswer: true, useDecisions: true, theme: 'system', answerSize: 17, transcriptSize: 14, overlaySize: 22, answerStyle: 'balanced' };

// Empty string means "use the default"
export const pref = (k) => { const v = session.me?.prefs?.[k]; return v === undefined || v === null || v === '' ? DEFAULT_PREFS[k] : v; };

const listeners = new Set();
export function onPrefsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Save preferences: applied immediately, sent to the server shortly after (debounced)
let pending = {};
let timer = null;
export function setPrefs(changes) {
  session.me.prefs = { ...session.me.prefs, ...changes };
  pending = { ...pending, ...changes };
  listeners.forEach((fn) => fn(changes));
  clearTimeout(timer);
  timer = setTimeout(flushPrefs, 600);
}
export async function flushPrefs() {
  clearTimeout(timer);
  if (!Object.keys(pending).length) return;
  const send = pending;
  pending = {};
  try { await api('PATCH', '/api/me', { prefs: send }); } catch { pending = { ...send, ...pending }; }
}
window.addEventListener('pagehide', () => { flushPrefs(); });

// ---------- theme ----------
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(theme = 'system') {
  try { localStorage.setItem('tma_theme', theme); } catch { /* storage unavailable */ }
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
export function storedTheme() {
  try { return localStorage.getItem('tma_theme') || 'system'; } catch { return 'system'; }
}
media.addEventListener('change', () => applyTheme(session.me ? pref('theme') : storedTheme()));

export async function loadModels() {
  if (!session.models) session.models = api('GET', '/api/models').catch((e) => { session.models = null; throw e; });
  return session.models;
}
