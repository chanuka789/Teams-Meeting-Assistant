// Small UI toolkit: element builder, icons, toasts, dialogs and shared widgets

import { ICONS } from './icons.js';

// h('div', { class: 'x', onclick: fn, attrs }, child, 'text', [children]) – text children are always escaped
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  // Icons are static SVG markup generated from lucide-static, never user input
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

export function button(label, { icon: ic, variant = '', size = '', onClick, title, type = 'button', disabled, ariaLabel } = {}) {
  const cls = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon'].filter(Boolean).join(' ');
  return h('button', { class: cls, type, onclick: onClick, title: title || (!label ? ariaLabel : undefined), 'aria-label': ariaLabel, disabled },
    ic && icon(ic), label);
}

// ---------- toasts ----------
export function toast(message, type = 'success') {
  const box = document.getElementById('toasts');
  const ic = { success: 'circle-check', error: 'triangle-alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: `toast ${type}` }, icon(ic), h('div', {}, message));
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 3500);
}

export function announce(text) {
  const el = document.getElementById('announcer');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}

// ---------- dialogs ----------
// openModal({ title, body: Node|Node[], actions: [{label, variant, onClick(close) -> false to keep open}] })
export function openModal({ title, description, body = [], actions = [], width }) {
  const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title', style: width ? { width } : undefined });
  const close = () => { dlg.close(); };
  const foot = h('div', { class: 'modal-foot' }, actions.map((a) => {
    const b = button(a.label, { variant: a.variant, icon: a.icon, type: a.submit ? 'submit' : 'button' });
    if (!a.submit) b.onclick = async () => { b.disabled = true; try { if ((await a.onClick?.(close)) !== false) close(); } finally { b.disabled = false; } };
    return b;
  }));
  const form = h('form', { method: 'dialog' },
    h('div', { class: 'modal-head' },
      h('div', { class: 'stack', style: { gap: '4px', flex: '1' } },
        h('h2', { id: 'modal-title' }, title),
        description && h('p', { class: 'muted small' }, description)),
      button('', { icon: 'x', variant: 'ghost', size: 'sm', ariaLabel: 'Close', onClick: close })),
    h('div', { class: 'modal-body' }, body),
    foot);
  const submitAction = actions.find((a) => a.submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!submitAction) return;
    const b = foot.querySelector('button[type=submit]');
    b.disabled = true;
    try { if ((await submitAction.onClick?.(close)) !== false) close(); } finally { b.disabled = false; }
  });
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const { dlg } = openModal({
      title,
      body: [h('p', { class: 'muted' }, message)],
      actions: [
        { label: 'Cancel', onClick: () => {} },
        { label: confirmLabel, variant: danger ? 'danger-solid' : 'primary', onClick: () => { ok = true; } },
      ],
    });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

// ---------- widgets ----------
export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint && h('div', { class: 'hint' }, hint));
}

export function switchEl(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, role: 'switch', onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), label);
}

// options: [{ value, label, icon }]
export function segmented(options, value, onChange, ariaLabel) {
  const wrap = h('div', { class: 'segmented', role: 'group', 'aria-label': ariaLabel });
  const render = (v) => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button', 'aria-pressed': String(o.value === v),
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.icon && icon(o.icon), o.label)));
  };
  render(value);
  wrap.setValue = render;
  return wrap;
}

// A− 17px A+ stepper
export function sizeStepper(value, { min, max, label, onChange }) {
  let v = value;
  const out = h('output', { 'aria-live': 'polite' }, `${v}px`);
  const minus = h('button', { type: 'button', 'aria-label': `Smaller ${label}`, title: `Smaller ${label}` }, icon('minus'));
  const plus = h('button', { type: 'button', 'aria-label': `Larger ${label}`, title: `Larger ${label}` }, icon('plus'));
  const set = (n) => {
    v = Math.max(min, Math.min(max, n));
    out.textContent = `${v}px`;
    minus.disabled = v <= min;
    plus.disabled = v >= max;
    onChange(v);
  };
  minus.onclick = () => set(v - 1);
  plus.onclick = () => set(v + 1);
  minus.disabled = v <= min;
  plus.disabled = v >= max;
  const el = h('div', { class: 'stepper', role: 'group', 'aria-label': `${label} text size` }, minus, out, plus);
  el.setValue = (n) => { v = n; out.textContent = `${v}px`; minus.disabled = v <= min; plus.disabled = v >= max; };
  return el;
}

export function emptyState({ icon: ic, title, text, extra }) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(ic)), h('h3', {}, title), text && h('p', {}, text), extra);
}

export function fileTypeBadge(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  const audio = ['mp3', 'm4a', 'mp4', 'aac', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'mpga', 'mpeg'].includes(ext);
  const kind = ['pdf', 'docx', 'pptx'].includes(ext) ? ext : audio ? 'audio' : 'text';
  if (audio) return h('span', { class: 'ftype audio', 'aria-hidden': 'true' }, icon('audio-lines'), h('small', {}, ext.toUpperCase().slice(0, 4)));
  return h('span', { class: `ftype ${kind}`, 'aria-hidden': 'true' }, kind === 'text' ? ext.toUpperCase().slice(0, 4) : ext.toUpperCase());
}

export function dropzone({ title, text, accept, multiple = true, onFiles }) {
  const input = h('input', { type: 'file', accept, multiple, onchange: () => { onFiles([...input.files]); input.value = ''; } });
  const zone = h('label', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': title },
    h('span', { class: 'dz-icon' }, icon('cloud-upload')),
    h('span', { class: 'stack', style: { gap: '2px' } }, h('b', {}, title), h('span', { class: 'small' }, text)),
    input);
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  return zone;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function fmtDate(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const timeStr = (d = new Date()) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- searchable select (combobox) ----------
// items: [{ value, label, sub, group, tags: [{ text, kind }] }]. Type to filter, ↑ ↓ Enter, Esc to close.
let comboSeq = 0;
// Phones and tablets: focusing a search box opens the on-screen keyboard, which resizes the page.
// Dropdowns there open without focusing their search box (tap it to type) and follow resizes instead of closing.
const isTouch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
// Height of the part of the screen the keyboard leaves free
const viewH = () => window.visualViewport?.height || window.innerHeight;
const offScreen = (el) => {
  const r = el.getBoundingClientRect();
  return !el.isConnected || (r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > viewH();
};

// compact: small trigger showing only the name (for toolbars); the list opens wider than the trigger.
export function combobox({ items, value, ariaLabel, placeholder = 'Search…', onChange, compact = false }) {
  const id = `cb${++comboSeq}`;
  let current = value;
  let open = false;
  let active = -1;
  let shown = [];

  const valueLabel = h('span', { class: 'combo-value' });
  const trigger = h('button', {
    type: 'button', class: 'combo-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': ariaLabel,
    title: compact ? ariaLabel : undefined,
  }, valueLabel, icon('chevron-down'));
  const search = h('input', {
    class: 'input', type: 'search', placeholder, autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': `${id}-list`, 'aria-autocomplete': 'list', 'aria-label': `Search ${ariaLabel}`,
  });
  const list = h('div', { class: 'combo-list', role: 'listbox', id: `${id}-list`, 'aria-label': ariaLabel });
  const count = h('div', { class: 'combo-count' });
  const pop = h('div', { class: 'combo-pop', hidden: true }, h('div', { class: 'input-icon' }, icon('search'), search), list, count);
  const wrap = h('div', { class: compact ? 'combo combo-compact' : 'combo' }, trigger, pop);

  const tagEls = (tags = []) => tags.map((t) => h('span', { class: `badge ${t.kind ? `badge-${t.kind}` : ''}` }, t.text));

  function renderValue() {
    const it = items.find((x) => x.value === current);
    if (compact) { valueLabel.textContent = it ? it.label : 'Choose…'; return; }
    // One line, like the other dropdowns: the name, then a short price (full details are in the list)
    valueLabel.replaceChildren(it
      ? h('span', { class: 'combo-line' }, h('span', { class: 'combo-name' }, it.label), (it.short || it.sub) && h('span', { class: 'combo-price' }, it.short || it.sub))
      : h('span', { class: 'subtle' }, 'Choose…'));
  }

  function renderList() {
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter((it) => {
      const hay = `${it.label} ${it.value} ${it.group || ''}`.toLowerCase(); // not the price text
      return terms.every((t) => hay.includes(t));
    });
    const nodes = [];
    let group = null;
    shown.forEach((it, i) => {
      if (it.group !== group) { group = it.group; if (group) nodes.push(h('div', { class: 'combo-group', role: 'presentation' }, group)); }
      nodes.push(h('div', {
        class: 'combo-opt', role: 'option', id: `${id}-o${i}`, 'aria-selected': String(it.value === current), 'data-i': i,
        onmousedown: (e) => { e.preventDefault(); choose(i); },
        onmousemove: () => setActive(i, false),
      }, h('span', { class: 'combo-check' }, it.value === current ? icon('check') : null),
      h('span', { class: 'combo-text' }, h('span', {}, it.label), it.sub && h('span', { class: 'subtle xs' }, it.sub)),
      h('span', { class: 'combo-tags' }, tagEls(it.tags))));
    });
    if (!shown.length) nodes.push(h('div', { class: 'combo-empty' }, 'No matches'));
    list.replaceChildren(...nodes);
    count.textContent = `${shown.length} of ${items.length}`;
    setActive(Math.max(0, shown.findIndex((x) => x.value === current)), true);
  }

  function setActive(i, scroll) {
    active = i;
    list.querySelectorAll('.combo-opt').forEach((o) => o.classList.toggle('active', Number(o.dataset.i) === i));
    const el = list.querySelector(`[data-i="${i}"]`);
    if (el) {
      search.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    const it = shown[i];
    if (!it) return;
    current = it.value;
    renderValue();
    close();
    trigger.focus();
    onChange(it.value);
  }

  // Open above or below, whichever has more room, and keep the list inside the visible screen
  function placePop() {
    if (offScreen(trigger)) { close(); return; }
    const r = trigger.getBoundingClientRect();
    const below = viewH() - r.bottom;
    const up = below < 300 && r.top > below;
    pop.classList.toggle('up', up);
    list.style.maxHeight = `${Math.max(120, Math.min(300, (up ? r.top : below) - 100))}px`;
    // Compact lists are wider than their trigger: shift them so they stay fully on screen
    if (compact) {
      const width = Math.min(420, window.innerWidth - 32);
      pop.style.width = `${width}px`;
      pop.style.left = `${Math.max(16 - r.left, Math.min(0, window.innerWidth - 16 - r.left - width))}px`;
    }
  }
  function openPop() {
    if (open) return;
    open = true;
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.value = '';
    placePop();
    renderList();
    if (!isTouch()) search.focus();
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, { capture: true, passive: true });
    window.addEventListener('resize', placePop);
    window.visualViewport?.addEventListener('resize', placePop);
  }
  function close() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('touchstart', outside, { capture: true });
    window.removeEventListener('resize', placePop);
    window.visualViewport?.removeEventListener('resize', placePop);
  }
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };

  trigger.addEventListener('click', () => (open ? close() : openPop()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openPop(); }
  });
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(shown.length - 1, active + 1), true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1), true); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
    else if (e.key === 'Tab') close();
  });

  renderValue();
  wrap.setValue = (v) => { current = v; renderValue(); };
  wrap.setItems = (next) => { items = next; renderValue(); };
  return wrap;
}

// ---------- dropdown: replaces native <select class="select"> with an app-styled listbox ----------
// The native select stays (hidden) as the source of truth, so code that sets .value, swaps options,
// toggles .disabled / .hidden or listens for 'change' keeps working. Long lists get a search box.
const SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
let ddSeq = 0;

export function enhanceSelect(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = '1';
  const id = `dd${++ddSeq}`;
  const valueEl = h('span', { class: 'dd-value' });
  const trigger = h('button', { type: 'button', class: 'dd-trigger', id: `${id}-btn`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, valueEl, icon('chevron-down'));
  const wrap = h('div', { class: `dd${select.classList.contains('select-sm') ? ' dd-sm' : ''}` });
  for (const k of ['width', 'maxWidth', 'minWidth', 'flex']) if (select.style[k]) wrap.style[k] = select.style[k];
  select.replaceWith(wrap);
  wrap.append(trigger, select);
  select.hidden = true;
  select.tabIndex = -1;

  // Accessible name: the select's aria-label, or its <label for="…">, which now points to the button
  const label = select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
  if (label) { label.htmlFor = trigger.id; label.id ||= `${id}-label`; trigger.setAttribute('aria-labelledby', `${label.id} ${trigger.id}`); }
  else if (select.getAttribute('aria-label')) trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  if (select.title) trigger.title = select.title;

  const render = () => {
    const opt = select.options[select.selectedIndex];
    valueEl.textContent = opt ? opt.textContent : '';
    trigger.disabled = select.disabled;
  };
  // Mirror programmatic changes: value, options, disabled
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return SELECT_VALUE.get.call(this); },
    set(v) { SELECT_VALUE.set.call(this, v); render(); },
  });
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  render();

  // ----- popup -----
  let pop = null;
  let items = [];
  let active = -1;
  let typed = '';
  let typedTimer;
  const options = () => [...select.querySelectorAll('option')];

  function build(filter = '') {
    const list = pop.querySelector('.dd-list');
    const f = filter.trim().toLowerCase();
    const nodes = [];
    items = [];
    let lastGroup = null;
    for (const o of options()) {
      if (f && !o.textContent.toLowerCase().includes(f)) continue;
      const group = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
      if (group !== lastGroup) { lastGroup = group; if (group) nodes.push(h('div', { class: 'dd-group', role: 'presentation' }, group)); }
      const i = items.length;
      items.push(o);
      nodes.push(h('div', {
        class: 'dd-opt', role: 'option', id: `${id}-o${i}`, 'aria-selected': String(o.selected), 'aria-disabled': o.disabled ? 'true' : undefined,
        onmousedown: (e) => { e.preventDefault(); choose(i); }, onmousemove: () => setActive(i, false),
      }, h('span', { class: 'dd-check' }, o.selected ? icon('check') : null),
      h('span', { class: 'dd-text' }, h('span', {}, o.textContent), o.dataset.hint && h('span', { class: 'dd-hint' }, o.dataset.hint))));
    }
    if (!items.length) nodes.push(h('div', { class: 'dd-empty' }, 'No matches'));
    list.replaceChildren(...nodes);
    setActive(Math.max(0, items.findIndex((o) => o.selected)), true);
  }

  function setActive(i, scroll) {
    active = i;
    pop.querySelectorAll('.dd-opt').forEach((el, k) => el.classList.toggle('active', k === i));
    const el = pop.querySelector(`#${id}-o${i}`);
    if (el) {
      pop.querySelector('.dd-list').setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    const o = items[i];
    if (!o || o.disabled) return;
    const changed = select.value !== o.value;
    select.value = o.value;
    close();
    trigger.focus();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function place() {
    if (!pop) return;
    if (offScreen(trigger)) { close(); return; } // its button was scrolled away or hidden
    const r = trigger.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, 200), window.innerWidth - 24);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 12 - w))}px`;
    // Fit the list into the room above or below the button (smaller while a phone keyboard is open)
    const vh = viewH();
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const list = pop.querySelector('.dd-list');
    list.style.maxHeight = '';
    const h0 = pop.offsetHeight;
    const up = below < h0 && above > below;
    const room = (up ? above : below) - 6;
    if (h0 > room) list.style.maxHeight = `${Math.max(120, room - (pop.offsetHeight - list.offsetHeight))}px`;
    if (up) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 6}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 6}px`; }
  }

  function open() {
    if (pop || trigger.disabled) return;
    const many = options().length > 10;
    const search = many && h('input', { class: 'input', type: 'search', placeholder: 'Search…', 'aria-label': 'Search options', autocomplete: 'off' });
    const list = h('div', { class: 'dd-list', role: 'listbox', tabindex: '-1', 'aria-labelledby': trigger.getAttribute('aria-labelledby') || undefined, 'aria-label': trigger.getAttribute('aria-label') || undefined });
    pop = h('div', { class: 'dd-pop' }, search && h('div', { class: 'input-icon' }, icon('search'), search), list);
    // Inside a modal dialog the popup must live in the dialog (top layer), elsewhere in <body>
    (trigger.closest('dialog') || document.body).append(pop);
    build();
    place();
    trigger.setAttribute('aria-expanded', 'true');
    const keyTarget = search || list;
    keyTarget.addEventListener('keydown', onKey);
    if (search) search.addEventListener('input', () => build(search.value));
    (isTouch() ? list : keyTarget).focus({ preventScroll: true });
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('touchstart', outside, { capture: true, passive: true });
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', place);
      window.visualViewport?.addEventListener('resize', place);
    });
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('touchstart', outside, { capture: true });
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('resize', place);
  }
  const outside = (e) => { if (!pop?.contains(e.target) && !trigger.contains(e.target)) close(); };
  // Page scrolls (e.g. the chat following a new message) move the list with its button instead of closing it
  const onScroll = (e) => { if (!pop?.contains(e.target)) place(); };

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1), true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1), true); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0, true); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1, true); }
    else if (e.key === 'Enter' || (e.key === ' ' && e.target.tagName !== 'INPUT')) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
    else if (e.key === 'Tab') close();
    else if (e.key.length === 1 && e.target.tagName !== 'INPUT') {
      // Type to jump to an option
      clearTimeout(typedTimer);
      typed += e.key.toLowerCase();
      typedTimer = setTimeout(() => { typed = ''; }, 600);
      const i = items.findIndex((o) => o.textContent.toLowerCase().replace(/^\w+:\s*/, '').startsWith(typed) || o.textContent.toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i, true);
    }
  }

  trigger.addEventListener('click', () => (pop ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
  });
  return wrap;
}

// Upgrade every native select (now and when pages add them)
export function autoEnhanceSelects() {
  const run = () => document.querySelectorAll('select.select:not([data-enhanced])').forEach(enhanceSelect);
  run();
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
}
