// Settings: profile and notes, appearance (theme + text sizes), AI models, usage and password

import { reasoningChoices, formatUsd } from '../../models.js';
import { h, icon, button, toast, field, segmented, switchEl, combobox } from '../ui.js';
import { ANSWER_STYLES } from '../format.js';
import { chatItems, sttItems, REASONING_LABELS, reasoningSelection, fillThinkingSelect } from '../model-items.js';
import { api } from '../api.js';
import { session, pref, setPrefs, applyTheme, loadModels } from '../state.js';

const SECTIONS = [
  { id: 'profile', label: 'Profile', short: 'Profile', icon: 'user-round' },
  { id: 'appearance', label: 'Appearance', short: 'Display', icon: 'sun' },
  { id: 'models', label: 'AI models', short: 'AI models', icon: 'bot' },
  { id: 'usage', label: 'Usage & cost', short: 'Usage', icon: 'gauge' },
  { id: 'security', label: 'Password', short: 'Password', icon: 'key-round' },
];

const section = (id, title, text, body, foot) => h('section', { class: 'card section', id: `s-${id}`, 'aria-labelledby': `h-${id}` },
  h('div', { class: 'section-head' }, h('h2', { id: `h-${id}` }, title), text && h('p', {}, text)),
  h('div', { class: 'section-body' }, body),
  foot && h('div', { class: 'section-foot' }, foot));

export async function renderSettings(page, { rebuildShell }) {
  const me = session.me;
  const highlight = (id) => navLinks.forEach((a) => a.setAttribute('aria-current', String(a.dataset.target === id)));
  let lockUntil = 0; // while a nav click scrolls, keep its item highlighted
  const navLinks = SECTIONS.map((s) => h('a', { href: `#/settings`, 'data-target': s.id, onclick: (e) => {
    e.preventDefault();
    highlight(s.id);
    lockUntil = Date.now() + 900;
    // Scroll the page and the (phone) tab strip separately: a second scrollIntoView would cancel the first
    const scroller = page.closest('.main');
    const target = page.querySelector(`#s-${s.id}`);
    const nav = e.currentTarget.parentElement;
    const offset = getComputedStyle(nav).position === 'sticky' && getComputedStyle(nav).flexDirection !== 'column' ? nav.offsetHeight + 12 : 24;
    if (target) scroller.scrollTo({ top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset, behavior: 'smooth' });
    nav.scrollTo({ left: e.currentTarget.offsetLeft - 16, behavior: 'smooth' });
  } }, icon(s.icon), h('span', { class: 'lbl' }, s.label), h('span', { class: 'short', 'aria-hidden': 'true' }, s.short)));
  navLinks[0].setAttribute('aria-current', 'true');

  page.replaceChildren(
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', {}, 'Settings'),
      h('p', {}, 'Your settings are saved to your account and follow you on any device.'))),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, navLinks),
      h('div', { class: 'stack', style: { gap: '24px' } },
        profileSection(me, rebuildShell), appearanceSection(), modelsSection(), usageSection(me), passwordSection())));

  // Highlight the section being read: the last one whose top has passed the upper part of the screen,
  // or the last section when scrolled to the bottom (short last sections never reach the top)
  const scroller = page.closest('.main');
  const sections = [...page.querySelectorAll('.settings > .stack > *')];
  let frame = 0;
  const onScroll = () => {
    if (!page.isConnected) { scroller.removeEventListener('scroll', onScroll); return; }
    if (Date.now() < lockUntil || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
      const current = atBottom ? sections[sections.length - 1] : sections.filter((s) => s.getBoundingClientRect().top <= line).pop() || sections[0];
      highlight(current.id.replace('s-', ''));
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
}

// ---------- profile ----------
function profileSection(me, rebuildShell) {
  const name = h('input', { class: 'input', value: me.name, autocomplete: 'name' });
  const profile = h('textarea', { class: 'textarea', rows: '3', placeholder: 'e.g. Quantity Surveyor working in the GCC, APC candidate, QS & Construction pathway, consultant side, 6 years experience' }, me.profile);
  const notes = h('textarea', { class: 'textarea', rows: '10', placeholder: 'Key facts you want the assistant to use: summary of experience per competency, project values and dates, CPD, ethics examples…' }, me.notes);
  const save = button('Save profile', { variant: 'primary', icon: 'check', type: 'submit' });
  const submit = async () => {
    save.disabled = true;
    try {
      const out = await api('PATCH', '/api/me', { name: name.value, profile: profile.value, notes: notes.value });
      const nameChanged = out.name !== session.me.name;
      Object.assign(session.me, { name: out.name, profile: out.profile, notes: out.notes });
      toast('Profile saved');
      if (nameChanged) rebuildShell();
    } catch (e) { toast(e.message, 'error'); } finally { save.disabled = false; }
  };
  return asForm(submit, section('profile', 'Profile', 'Used by the assistant to answer as you.', [
    h('div', { class: 'grid-2' }, field('Name', name), field('Username', h('input', { class: 'input', value: me.username, disabled: true }), 'Ask an admin to change it.')),
    field('About you', profile, 'Your role, region and pathway. Answers use your region’s practice, e.g. GCC: FIDIC and POMI.'),
    field('Notes', notes, 'Short facts that are not in your documents. Long documents belong in My case study.'),
  ], save));
}

// Wrap a section in a form so Enter and password managers work
function asForm(onSubmit, sectionEl) {
  const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); onSubmit(); } });
  sectionEl.replaceWith?.(form);
  form.append(sectionEl);
  form.id = sectionEl.id;
  sectionEl.removeAttribute('id');
  form.className = 'section-form';
  return form;
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
  const body = h('div', { class: 'stack', style: { gap: '20px' } }, h('div', { class: 'skeleton', style: { height: '40px' } }), h('div', { class: 'skeleton', style: { height: '40px' } }));
  const auto = switchEl('Answer detected questions automatically', pref('autoAnswer'), (v) => setPrefs({ autoAnswer: v }));
  const style = h('select', { class: 'select', onchange: () => { setPrefs({ answerStyle: style.value }); toast('Answer style saved'); } },
    ANSWER_STYLES.map((s) => h('option', { value: s.id, selected: s.id === pref('answerStyle') }, `${s.label} — ${s.hint}`)));
  const reset = button('Reset to defaults', { variant: 'ghost', icon: 'eraser' });
  const el = section('models', 'AI models', 'Live list from OpenRouter with prices. Live interview and Chat have separate settings. Changes apply to the next question.', [
    h('div', { class: 'grid-2' }, field('Answer style', style, 'Also on the Live interview screen.'), h('div', { class: 'field', style: { justifyContent: 'flex-end' } }, auto)),
    h('hr', { class: 'divider' }), body], reset);

  loadModels().then((data) => {
    const d = data.defaults;
    const chosen = (k, def) => pref(k) || def;
    const reasoningSel = h('select', { class: 'select', onchange: () => setPrefs({ reasoning: reasoningSel.value }) });
    const drawReasoning = () => {
      const model = data.answer.find((m) => m.id === chosen('answerModel', d.answerModel));
      const choices = reasoningChoices(model);
      reasoningSel.disabled = !choices.length;
      if (!choices.length) { reasoningSel.replaceChildren(h('option', {}, 'Not used by this model')); return; }
      const sel = reasoningSelection(choices, chosen('reasoning', d.reasoning));
      reasoningSel.replaceChildren(...choices.map((c) => h('option', { value: c, selected: c === sel }, REASONING_LABELS[c] || c)));
    };
    const answer = combobox({
      items: chatItems(data.answer, d.answerModel), value: chosen('answerModel', d.answerModel), ariaLabel: 'Answer model',
      placeholder: 'Search 380+ models, e.g. claude, gpt, gemini…',
      onChange: (v) => { setPrefs({ answerModel: v, reasoning: '' }); drawReasoning(); toast('Answer model saved'); },
    });
    const detect = combobox({
      items: chatItems(data.answer, d.detectModel), value: chosen('detectModel', d.detectModel), ariaLabel: 'Question detection model',
      placeholder: 'Search models…', onChange: (v) => { setPrefs({ detectModel: v }); toast('Detection model saved'); },
    });
    const stt = combobox({
      items: sttItems(data.stt, d.sttModel), value: chosen('sttModel', d.sttModel), ariaLabel: 'Speech-to-text model',
      placeholder: 'Search speech-to-text models…', onChange: (v) => { setPrefs({ sttModel: v }); toast('Speech-to-text model saved'); },
    });
    // Chat page: its own model and thinking level
    const chatThinking = h('select', { class: 'select', onchange: () => setPrefs({ chatReasoning: chatThinking.value }) });
    const drawChatThinking = () => fillThinkingSelect(chatThinking, data.answer.find((m) => m.id === chosen('chatModel', d.answerModel)),
      chosen('chatReasoning', d.reasoning), reasoningChoices);
    const chatModel = combobox({
      items: chatItems(data.answer, d.answerModel), value: chosen('chatModel', d.answerModel), ariaLabel: 'Chat model',
      placeholder: 'Search models…', onChange: (v) => { setPrefs({ chatModel: v, chatReasoning: '' }); drawChatThinking(); toast('Chat model saved'); },
    });
    reset.onclick = () => {
      setPrefs({ answerModel: '', reasoning: '', detectModel: '', sttModel: '', answerStyle: '', chatModel: '', chatReasoning: '' });
      answer.setValue(d.answerModel); detect.setValue(d.detectModel); stt.setValue(d.sttModel); chatModel.setValue(d.answerModel);
      style.value = pref('answerStyle');
      drawReasoning();
      drawChatThinking();
      toast('Models reset to defaults');
    };
    drawReasoning();
    drawChatThinking();
    const labelled = (text, control, hint) => h('div', { class: 'field' }, h('span', { class: 'label' }, text), control, hint && h('div', { class: 'hint' }, hint));
    body.replaceChildren(
      labelled('Answer model', answer, `${data.answer.length} chat models. Writes the answers: stronger models are more accurate but slower.`),
      h('div', { class: 'grid-2' },
        field('Thinking level', reasoningSel, 'Higher is more careful but slower.'),
        labelled('Question detection model', detect, 'Decides if speech is a question. Fast and cheap is best.')),
      labelled('Speech-to-text model', stt, `${data.stt.length} models. English only.`),
      h('hr', { class: 'divider' }),
      h('div', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'label' }, 'Chat page'),
        h('span', { class: 'hint' }, 'The Chat page has its own model and thinking level, separate from the Live interview answers.')),
      h('div', { class: 'grid-2' },
        labelled('Chat model', chatModel),
        field('Chat thinking level', chatThinking)));
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
        stat('Total', formatUsd(x.total)), stat('Live answers', formatUsd(x.answer)), stat('Chat', formatUsd(x.chat)),
        stat('Speech-to-text', formatUsd(x.stt)), stat('Question detection', formatUsd(x.detect))),
      h('span', { class: 'hint' }, `Live: ${x.answers} answer${x.answers === 1 ? '' : 's'} · average ${x.answers ? formatUsd(x.answer / x.answers) : '–'} per answer`),
      h('span', { class: 'hint' }, `Chat: ${x.chats} ${x.chats === 1 ? 'reply' : 'replies'} · average ${x.chats ? formatUsd(x.chat / x.chats) : '–'} per reply (follow-up suggestions included)`));
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
  const save = button('Change password', { variant: 'primary', icon: 'lock', type: 'submit' });
  const submit = async () => {
    if (next.value !== confirm.value) { toast('The new passwords do not match.', 'error'); return; }
    save.disabled = true;
    try {
      await api('POST', '/api/me/password', { current: current.value, next: next.value });
      current.value = next.value = confirm.value = '';
      toast('Password changed. Other devices were signed out.');
    } catch (e) { toast(e.message, 'error'); } finally { save.disabled = false; }
  };
  return asForm(submit, section('security', 'Password', 'At least 8 characters. Changing it signs out your other devices.', [
    // Hidden username so password managers know which account this is
    h('input', { type: 'text', autocomplete: 'username', value: session.me.username, hidden: true, readonly: true, 'aria-hidden': 'true', tabindex: '-1' }),
    field('Current password', current),
    h('div', { class: 'grid-2' }, field('New password', next), field('Confirm new password', confirm)),
  ], save));
}
