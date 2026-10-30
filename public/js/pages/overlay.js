// Floating answers: an always-on-top window (Document Picture-in-Picture, Chrome/Edge 116+) that shows the
// latest answer like a subtitle. It can be dragged anywhere on the screen, over the Teams window.
// Browsers without the API get a normal pop-up window instead (not always on top).

import { h, icon, sizeStepper, toast } from '../ui.js';
import { pref, setPrefs } from '../state.js';
import { parseAnswer } from '../format.js';

export { parseAnswer };

export const supportsPip = () => 'documentPictureInPicture' in window;

export const answerNodes = (blocks) => blocks.map((b) => (b.type === 'p' ? h('p', {}, b.text) : h('ul', {}, b.items.map((t) => h('li', {}, t)))));

const SIZE_KEY = 'tma_overlay_size';

export function createOverlay({ getAnswers, getStatus }) {
  let win = null;
  let index = -1;          // -1 = always show the latest answer
  let themeObserver = null;

  const statusEl = h('span', { class: 'ov-status' }, h('span', { class: 'dot' }), h('span', {}, 'Ready'));
  const pos = h('span', { class: 'ov-pos num' });
  const prev = h('button', { type: 'button', class: 'ov-btn', 'aria-label': 'Previous answer', title: 'Previous (←)', onclick: () => step(-1) }, icon('chevron-left'));
  const next = h('button', { type: 'button', class: 'ov-btn', 'aria-label': 'Next answer', title: 'Next (→)', onclick: () => step(1) }, icon('chevron-right'));
  const size = sizeStepper(pref('overlaySize'), { min: 14, max: 48, label: 'floating answer', onChange: (v) => { setPrefs({ overlaySize: v }); applySize(); } });
  const q = h('div', { class: 'ov-q' });
  const a = h('div', { class: 'ov-a' });
  const empty = h('div', { class: 'ov-empty' }, icon('captions'), h('span', {}, 'The next answer will appear here.'));
  const body = h('main', { class: 'ov-body' }, empty, q, a);
  const root = h('div', { class: 'ov' },
    h('header', { class: 'ov-bar' }, statusEl, h('span', { class: 'spacer' }), prev, pos, next, size),
    body);

  function applySize() { root.style.setProperty('--ov-size', `${pref('overlaySize')}px`); }

  function step(d) {
    const n = getAnswers().length;
    if (!n) return;
    const cur = index < 0 ? n - 1 : index;
    const to = Math.max(0, Math.min(n - 1, cur + d));
    index = to === n - 1 ? -1 : to;
    render();
  }

  function render() {
    if (!win) return;
    const list = getAnswers();
    const n = list.length;
    const i = index < 0 ? n - 1 : index;
    const ans = list[i];
    prev.disabled = i <= 0;
    next.disabled = i >= n - 1;
    pos.textContent = n ? `${i + 1} / ${n}` : '';
    empty.hidden = Boolean(ans);
    if (!ans) { q.textContent = ''; a.replaceChildren(); return; }
    const parsed = parseAnswer(ans.text);
    q.textContent = parsed.question || ans.question;
    a.replaceChildren(...(parsed.blocks.length ? answerNodes(parsed.blocks) : [h('div', { class: 'typing' }, h('i'), h('i'), h('i'))]));
    if (index < 0) body.scrollTop = 0;
  }

  function renderStatus() {
    const { text, kind } = getStatus();
    statusEl.className = `ov-status ${kind}`.trim();
    statusEl.lastChild.textContent = text;
  }

  function copyStyles(doc) {
    for (const node of document.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"], style')) doc.head.append(node.cloneNode(true));
    doc.head.append(h('title', {}, 'APC answers'));
    const syncTheme = () => doc.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme'));
    syncTheme();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  async function open() {
    if (win) { win.focus(); return; }
    let saved = { width: 560, height: 300 };
    try { saved = { ...saved, ...JSON.parse(localStorage.getItem(SIZE_KEY) || '{}') }; } catch { /* default size */ }
    if (supportsPip()) {
      win = await window.documentPictureInPicture.requestWindow({ width: saved.width, height: saved.height });
    } else {
      win = window.open('', 'apc-answers', `popup,width=${saved.width},height=${saved.height}`);
      if (!win) { toast('The browser blocked the pop-up window. Allow pop-ups for this site and try again.', 'error'); return; }
      win.document.body.replaceChildren();
      toast('Your browser cannot keep the window on top. Use Chrome or Edge for an always-on-top window.', 'info');
    }
    copyStyles(win.document);
    win.document.body.className = 'ov-page';
    win.document.body.append(root);
    win.document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
    win.addEventListener('resize', () => {
      try { localStorage.setItem(SIZE_KEY, JSON.stringify({ width: win.innerWidth, height: win.innerHeight })); } catch { /* ignore */ }
    });
    win.addEventListener('pagehide', () => {
      themeObserver?.disconnect();
      win = null;
      onChange();
    });
    index = -1;
    applySize();
    renderStatus();
    render();
    onChange();
  }

  function close() { win?.close(); }

  let onChange = () => {};
  return {
    open,
    close,
    isOpen: () => Boolean(win),
    onOpenChange(fn) { onChange = fn; },
    // A new answer started: jump back to the latest one
    newAnswer() { index = -1; render(); },
    update: render,
    updateStatus() { if (win) renderStatus(); },
  };
}
