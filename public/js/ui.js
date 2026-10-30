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
  const kind = ['pdf', 'docx', 'pptx'].includes(ext) ? ext : 'text';
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
