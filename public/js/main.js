// App entry: sign-in / first-time setup, app shell (sidebar + pages) and hash routing

import { h, icon, button, segmented, initials, toast } from './ui.js';
import { api, setUnauthorizedHandler } from './api.js';
import { session, pref, setPrefs, applyTheme, flushPrefs, onPrefsChange } from './state.js';
import { renderAuth } from './pages/auth.js';
import { createLivePage } from './pages/live.js';
import { renderLibrary } from './pages/library.js';
import { renderCaseStudy } from './pages/casestudy.js';
import { renderSettings } from './pages/settings.js';
import { renderUsers } from './pages/users.js';
import { renderChat } from './pages/chat.js';

const root = document.getElementById('root');
let live = null;          // the live page stays mounted in memory so listening continues across pages
let shell = null;

const ROUTES = [
  { path: 'live', label: 'Live interview', icon: 'radio-tower', group: 'Interview' },
  { path: 'chat', label: 'Chat', icon: 'messages-square', group: 'Interview' },
  { path: 'library', label: 'Competency library', icon: 'library', group: 'Knowledge' },
  { path: 'case-study', label: 'My case study', icon: 'folder-lock', group: 'Knowledge' },
  { path: 'settings', label: 'Settings', icon: 'settings', group: 'Account' },
  { path: 'users', label: 'Users', icon: 'users', group: 'Account', admin: true },
];

function currentRoute() {
  const [path = 'live', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES.find((r) => r.path === path && (!r.admin || session.me?.role === 'admin')) || ROUTES[0];
  return { route, params: rest };
}

function themeSwitch() {
  return segmented([
    { value: 'light', label: '', icon: 'sun' },
    { value: 'system', label: '', icon: 'monitor' },
    { value: 'dark', label: '', icon: 'moon' },
  ].map((o) => ({ ...o, label: h('span', { class: 'sr-only' }, `${o.value} theme`) })), pref('theme'), (v) => {
    setPrefs({ theme: v });
    applyTheme(v);
  }, 'Colour theme');
}

function buildShell() {
  const me = session.me;
  const navLinks = new Map();
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, groups.map((g) => [
    h('div', { class: 'nav-label' }, g),
    ROUTES.filter((r) => r.group === g && (!r.admin || me.role === 'admin')).map((r) => {
      const a = h('a', { href: `#/${r.path}`, onclick: () => app.classList.remove('nav-open') }, icon(r.icon), r.label);
      navLinks.set(r.path, a);
      return a;
    }),
  ]));
  const theme = themeSwitch();
  theme.classList.add('theme-switch');
  // Keep the sidebar switch in step when the theme is changed in Settings
  onPrefsChange((c) => { if ('theme' in c && theme.isConnected) theme.setValue(c.theme); });
  const brand = () => h('div', { class: 'brand' },
    h('div', { class: 'logo' }, icon('audio-lines')),
    h('div', {}, h('div', { class: 'brand-name' }, 'APC Assistant'), h('div', { class: 'brand-sub' }, 'RICS interview companion')));
  const sidebar = h('aside', { class: 'sidebar' },
    brand(),
    nav,
    h('div', { class: 'sidebar-foot' },
      theme,
      h('div', { class: 'user-chip' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(me.name)),
        h('div', { class: 'who' }, h('b', {}, me.name), h('span', {}, me.role === 'admin' ? 'Admin' : 'Member')),
        button('', { icon: 'log-out', variant: 'ghost', size: 'sm', ariaLabel: 'Sign out', onClick: signOut }))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const app = h('div', { class: 'app' },
    h('header', { class: 'topbar' },
      button('', { icon: 'menu', variant: 'ghost', ariaLabel: 'Open menu', onClick: () => app.classList.add('nav-open') }),
      brand()),
    sidebar,
    h('div', { class: 'scrim', onclick: () => app.classList.remove('nav-open') }),
    main);
  root.replaceChildren(app);
  // Phone menu: Esc closes it
  app.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.classList.contains('nav-open')) app.classList.remove('nav-open'); });
  return { app, main, navLinks };
}

async function route() {
  if (!shell) return;
  const { route: r, params } = currentRoute();
  for (const [path, a] of shell.navLinks) {
    if (path === r.path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${r.label} · APC Assistant`;
  shell.app.classList.remove('nav-open');
  flushPrefs();
  const { main } = shell;
  main.scrollTop = 0;
  if (r.path === 'live') {
    main.replaceChildren(live.el);
    live.onShow();
    return;
  }
  if (r.path === 'chat') {
    const chat = h('div', { class: 'chat-page' });
    main.replaceChildren(chat);
    await renderChat(chat, params);
    return;
  }
  const page = h('div', { class: 'page' });
  main.replaceChildren(page);
  if (r.path === 'library') await renderLibrary(page, params);
  else if (r.path === 'case-study') await renderCaseStudy(page);
  else if (r.path === 'settings') await renderSettings(page, { rebuildShell });
  else if (r.path === 'users') await renderUsers(page);
}

function setLiveIndicator(listening) {
  const a = shell?.navLinks.get('live');
  if (!a) return;
  a.querySelector('.live-dot')?.remove();
  if (listening) a.append(h('span', { class: 'live-dot', title: 'Listening' }, h('span', { class: 'sr-only' }, '(listening)')));
}

// Rebuild the sidebar (after a name or role change) without losing the live page
export function rebuildShell() {
  shell = buildShell();
  setLiveIndicator(live?.isListening());
  route();
}

async function signOut() {
  if (live?.isListening()) live.stop();
  await flushPrefs();
  await api('POST', '/api/logout').catch(() => {});
  location.hash = '';
  location.reload();
}

async function showSignedIn() {
  applyTheme(pref('theme'));
  live = createLivePage({ onListeningChange: setLiveIndicator });
  shell = buildShell();
  window.addEventListener('hashchange', route);
  await route();
}

async function boot() {
  setUnauthorizedHandler(() => {
    if (session.me) { toast('Your session ended. Please sign in again.', 'info'); setTimeout(() => location.reload(), 1200); }
  });
  try {
    session.me = await api('GET', '/api/me');
  } catch {
    let setup = { needsSetup: false, keyRequired: false };
    try { setup = await api('GET', '/api/setup'); } catch { /* server unreachable: show sign-in */ }
    renderAuth(root, { setup, onDone: () => location.reload() });
    return;
  }
  await showSignedIn();
}

boot();
