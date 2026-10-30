// Settings: profile and notes, appearance (theme + text sizes), AI models, usage and password

import { reasoningChoices, formatUsd } from '../../models.js';
import { h, icon, button, toast, field, segmented, switchEl } from '../ui.js';
import { api } from '../api.js';
import { session, pref, setPrefs, applyTheme, loadModels } from '../state.js';

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: 'user-round' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'models', label: 'AI models', icon: 'bot' },
  { id: 'usage', label: 'Usage & cost', icon: 'gauge' },
  { id: 'security', label: 'Password', icon: 'key-round' },
];
const REASONING_LABELS = {
  none: 'Off (fastest)', minimal: 'Minimal', low: 'Low (fast)', medium: 'Medium',
  high: 'High (slower)', xhigh: 'Extra high (slow)', max: 'Max (slowest)',
};

const section = (id, title, text, body, foot) => h('section', { class: 'card section', id: `s-${id}`, 'aria-labelledby': `h-${id}` },
  h('div', { class: 'section-head' }, h('h2', { id: `h-${id}` }, title), text && h('p', {}, text)),
  h('div', { class: 'section-body' }, body),
  foot && h('div', { class: 'section-foot' }, foot));

export async function renderSettings(page, { rebuildShell }) {
  const me = session.me;
  const navLinks = SECTIONS.map((s) => h('a', { href: `#/settings`, 'data-target': s.id, onclick: (e) => {
    e.preventDefault();
    page.querySelector(`#s-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    navLinks.forEach((a) => a.setAttribute('aria-current', String(a === e.currentTarget)));
  } }, icon(s.icon), s.label));
  navLinks[0].setAttribute('aria-current', 'true');

  page.replaceChildren(
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', {}, 'Settings'),
      h('p', {}, 'Your settings are saved to your account and follow you on any device.'))),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, navLinks),
      h('div', { class: 'stack', style: { gap: '24px' } },
        profileSection(me, rebuildShell), appearanceSection(), modelsSection(), usageSection(me), passwordSection())));
}

// ---------- profile ----------
function profileSection(me, rebuildShell) {
  const name = h('input', { class: 'input', value: me.name, autocomplete: 'name' });
  const profile = h('textarea', { class: 'textarea', rows: '3', placeholder: 'e.g. Quantity Surveyor working in the GCC, APC candidate, QS & Construction pathway, consultant side, 6 years experience' }, me.profile);
  const notes = h('textarea', { class: 'textarea', rows: '10', placeholder: 'Key facts you want the assistant to use: summary of experience per competency, project values and dates, CPD, ethics examples…' }, me.notes);
  const save = button('Save profile', { variant: 'primary', icon: 'check', onClick: async () => {
    save.disabled = true;
    try {
      const out = await api('PATCH', '/api/me', { name: name.value, profile: profile.value, notes: notes.value });
      const nameChanged = out.name !== session.me.name;
      Object.assign(session.me, { name: out.name, profile: out.profile, notes: out.notes });
      toast('Profile saved');
      if (nameChanged) rebuildShell();
    } catch (e) { toast(e.message, 'error'); } finally { save.disabled = false; }
  } });
  return section('profile', 'Profile', 'Used by the assistant to answer as you.', [
    h('div', { class: 'grid-2' }, field('Name', name), field('Username', h('input', { class: 'input', value: me.username, disabled: true }), 'Ask an admin to change it.')),
    field('About you', profile, 'Your role, region and pathway. Answers use your region’s practice, e.g. GCC: FIDIC and POMI.'),
    field('Notes', notes, 'Short facts that are not in your documents. Long documents belong in My case study.'),
  ], save);
}

// ---------- appearance ----------
function appearanceSection() {
  const theme = segmented([
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
    { value: 'system', label: 'System', icon: 'monitor' },
  ], pref('theme'), (v) => { setPrefs({ theme: v }); applyTheme(v); }, 'Colour theme');

  const slider = (key, min, max, label, sample) => {
    const out = h('output', { class: 'num badge' }, `${pref(key)}px`);
    const preview = h('div', { class: 'preview', style: { fontSize: `${pref(key)}px`, lineHeight: '1.5' } }, sample);
    const input = h('input', { type: 'range', class: 'range', min, max, step: '1', value: pref(key), 'aria-label': `${label} text size`, oninput: () => {
      const v = Number(input.value);
      out.textContent = `${v}px`;
      preview.style.fontSize = `${v}px`;
      setPrefs({ [key]: v });
    } });
    return h('div', { class: 'stack', style: { gap: '8px' } },
      h('div', { class: 'row' }, h('span', { class: 'label' }, `${label} text size`), h('span', { class: 'spacer' }), out), input, preview);
  };

  return section('appearance', 'Appearance', 'Theme and text sizes. You can also change text sizes on the Live interview screen.', [
    h('div', { class: 'setting-row' }, h('div', { class: 'text' }, h('b', {}, 'Theme'), h('span', {}, 'System follows your computer’s light or dark setting.')), theme),
    h('hr', { class: 'divider' }),
    slider('answerSize', 12, 36, 'Answer', h('div', {}, h('p', { style: { margin: '0 0 .4em' } }, 'NRM 1 sets rules for order of cost estimates and cost plans.'),
      h('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, h('li', {}, 'Elemental cost plans by RIBA stage'), h('li', {}, 'As a QS, I report cost movements to the client')))),
    slider('transcriptSize', 11, 30, 'Transcript', 'Can you talk me through how you prepared the elemental cost plan?'),
  ]);
}

// ---------- AI models ----------
function modelsSection() {
  const body = h('div', { class: 'stack', style: { gap: '20px' } }, h('div', { class: 'skeleton', style: { height: '38px' } }), h('div', { class: 'skeleton', style: { height: '38px' } }));
  const auto = switchEl('Answer detected questions automatically', pref('autoAnswer'), (v) => setPrefs({ autoAnswer: v }));
  const reset = button('Reset to defaults', { variant: 'ghost', icon: 'eraser' });
  const el = section('models', 'AI models', 'Live list from OpenRouter with prices. Changes apply to your next question.', [auto, h('hr', { class: 'divider' }), body], reset);

  loadModels().then((data) => {
    const d = data.defaults;
    const chosen = (k, def) => pref(k) || def;
    const price = (m) => (m.input == null ? '' : m.input === 0 && m.output === 0 ? 'free' : `$${m.input} in / $${m.output} out per 1M tokens`);
    const sttPrice = (p) => (!p ? 'price: see OpenRouter' : p.perHour != null ? `$${p.perHour} per audio hour` : price(p));

    const fillChat = (select, current, defaultId, q = '') => {
      const groups = new Map();
      for (const m of data.answer.filter((x) => !q || x.id === current || x.name.toLowerCase().includes(q) || x.id.includes(q))) {
        const provider = m.name.includes(':') ? m.name.split(':')[0] : m.id.split('/')[0];
        if (!groups.has(provider)) groups.set(provider, []);
        groups.get(provider).push(m);
      }
      select.replaceChildren(...[...groups].map(([provider, items]) => h('optgroup', { label: provider }, items.map((m) => {
        const label = m.name.includes(':') ? m.name.split(':').slice(1).join(':').trim() : m.name;
        const tags = [price(m), m.id === defaultId ? 'default' : ''].filter(Boolean).join(' · ');
        return h('option', { value: m.id, selected: m.id === current }, tags ? `${label} — ${tags}` : label);
      }))));
    };

    const answerSearch = h('input', { class: 'input', type: 'search', placeholder: 'Search models, e.g. claude, gpt, gemini…', 'aria-label': 'Search answer models' });
    const answerSel = h('select', { class: 'select', 'aria-label': 'Answer model' });
    const reasoningSel = h('select', { class: 'select' });
    const detectSel = h('select', { class: 'select' });
    const sttSel = h('select', { class: 'select' });

    const drawReasoning = () => {
      const model = data.answer.find((m) => m.id === chosen('answerModel', d.answerModel));
      const choices = reasoningChoices(model);
      reasoningSel.disabled = !choices.length;
      if (!choices.length) { reasoningSel.replaceChildren(h('option', {}, 'Not used by this model')); return; }
      const wanted = chosen('reasoning', d.reasoning);
      const sel = choices.includes(wanted) ? wanted : choices.includes('low') ? 'low' : choices[choices.length - 1];
      reasoningSel.replaceChildren(...choices.map((c) => h('option', { value: c, selected: c === sel }, REASONING_LABELS[c] || c)));
    };
    const draw = () => {
      fillChat(answerSel, chosen('answerModel', d.answerModel), d.answerModel, answerSearch.value.trim().toLowerCase());
      fillChat(detectSel, chosen('detectModel', d.detectModel), d.detectModel);
      sttSel.replaceChildren(...data.stt.map((m) => h('option', { value: m.id, selected: m.id === chosen('sttModel', d.sttModel) },
        `${m.name} — ${sttPrice(m.price)}${m.id === d.sttModel ? ' · default' : ''}`)));
      drawReasoning();
    };
    answerSearch.oninput = () => fillChat(answerSel, chosen('answerModel', d.answerModel), d.answerModel, answerSearch.value.trim().toLowerCase());
    answerSel.onchange = () => { setPrefs({ answerModel: answerSel.value }); drawReasoning(); toast('Answer model saved'); };
    reasoningSel.onchange = () => setPrefs({ reasoning: reasoningSel.value });
    detectSel.onchange = () => { setPrefs({ detectModel: detectSel.value }); toast('Detection model saved'); };
    sttSel.onchange = () => { setPrefs({ sttModel: sttSel.value }); toast('Speech-to-text model saved'); };
    reset.onclick = () => { setPrefs({ answerModel: '', reasoning: '', detectModel: '', sttModel: '' }); answerSearch.value = ''; draw(); toast('Models reset to defaults'); };
    draw();

    body.replaceChildren(
      h('div', { class: 'field' }, h('label', { class: 'label', for: answerSel.id = 'answer-model' }, 'Answer model'),
        h('div', { class: 'input-icon' }, icon('search'), answerSearch), answerSel,
        h('div', { class: 'hint' }, `${data.answer.length} chat models. Writes the answers: stronger models are more accurate but slower.`)),
      h('div', { class: 'grid-2' },
        field('Thinking level', reasoningSel, 'Higher is more careful but slower.'),
        field('Question detection model', detectSel, 'Decides if speech is a question. Fast and cheap is best.')),
      field('Speech-to-text model', sttSel, `${data.stt.length} models. English only.`));
  }).catch((e) => body.replaceChildren(h('div', { class: 'callout warn' }, icon('triangle-alert'), h('div', {}, e.message))));
  return el;
}

// ---------- usage ----------
function usageSection(me) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '72px' } }));
  api('GET', '/api/me/usage').then((u) => {
    const stat = (label, v) => h('div', { class: 'stat' }, h('span', {}, label), h('b', {}, v));
    const block = (title, x) => h('div', { class: 'stack', style: { gap: '8px' } }, h('span', { class: 'label' }, title),
      h('div', { class: 'stats' },
        stat('Total', formatUsd(x.total)), stat('Answers', `${formatUsd(x.answer)}`),
        stat('Speech-to-text', formatUsd(x.stt)), stat('Detection', formatUsd(x.detect))),
      h('span', { class: 'hint' }, `${x.answers} answers · average ${x.answers ? formatUsd(x.answer / x.answers) : '–'} per answer`));
    body.replaceChildren(block('This month', u.month), block('All time', u.all));
    if (me.role === 'admin') {
      const key = h('div', { class: 'callout' }, icon('wallet'), h('div', {}, 'Loading OpenRouter account…'));
      body.append(key);
      api('GET', '/api/key-usage').then((k) => {
        key.lastChild.textContent = typeof k.usage === 'number'
          ? `OpenRouter key: ${formatUsd(k.usage)} used in total${k.limit == null ? ', no spending limit set.' : `, ${formatUsd(k.limitRemaining)} left of ${formatUsd(k.limit)} limit.`}`
          : 'OpenRouter key usage is not available.';
      }).catch(() => { key.lastChild.textContent = 'OpenRouter key usage is not available.'; });
    }
  }).catch((e) => body.replaceChildren(h('p', { class: 'muted' }, e.message)));
  return section('usage', 'Usage & cost', 'Real amounts charged by OpenRouter for your account (USD).', body);
}

// ---------- password ----------
function passwordSection() {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const save = button('Change password', { variant: 'primary', icon: 'lock', onClick: async () => {
    if (next.value !== confirm.value) { toast('The new passwords do not match.', 'error'); return; }
    save.disabled = true;
    try {
      await api('POST', '/api/me/password', { current: current.value, next: next.value });
      current.value = next.value = confirm.value = '';
      toast('Password changed. Other devices were signed out.');
    } catch (e) { toast(e.message, 'error'); } finally { save.disabled = false; }
  } });
  return section('security', 'Password', 'At least 8 characters. Changing it signs out your other devices.', [
    field('Current password', current),
    h('div', { class: 'grid-2' }, field('New password', next), field('Confirm new password', confirm)),
  ], save);
}
