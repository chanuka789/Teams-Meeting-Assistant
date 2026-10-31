// Settings: profile and notes, appearance, Live interview / Chat / Voice models, fast decisions, usage and password.
// Layout: sections with a heading, each holding cards of rows (label and help on the left, the control on the right;
// stacked on narrow screens). Most settings save as soon as they change; Profile and Password have a Save button.

import { reasoningChoices, formatUsd, englishFirst } from '../../models.js';
import { h, icon, button, toast, segmented, switchEl, combobox } from '../ui.js';
import { ANSWER_STYLES } from '../format.js';
import { chatItems, sttItems, REASONING_LABELS, reasoningSelection } from '../model-items.js';
import { api } from '../api.js';
import { session, pref, setPrefs, applyTheme, loadModels, flushPrefs } from '../state.js';

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: 'user-round' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'live', label: 'Live interview', short: 'Live', icon: 'radio-tower' },
  { id: 'chat', label: 'Chat', icon: 'messages-square' },
  { id: 'voice', label: 'Voice', icon: 'audio-lines' },
  { id: 'advanced', label: 'Advanced', icon: 'sliders-horizontal' },
  { id: 'usage', label: 'Usage & cost', short: 'Usage', icon: 'gauge' },
  { id: 'security', label: 'Password', icon: 'key-round' },
];

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

// ---------- building blocks ----------
// One setting row. Form controls get a real <label>; other controls (pickers, switches) are named by the label.
function row(label, hint, control, { stack = false } = {}) {
  const isField = control instanceof HTMLElement && control.matches('input, textarea, select');
  const labelId = nextId('lbl');
  if (isField) control.id ||= nextId('ctl');
  else if (control instanceof HTMLElement) {
    const target = control.matches('.switch') ? control.querySelector('input') : control.querySelector('button, input') || control;
    if (target && !target.getAttribute('aria-label')) target.setAttribute('aria-labelledby', labelId);
  }
  // Switches and single buttons stay beside their label even on phones
  const compact = control instanceof HTMLElement && control.matches('.switch-only, .btn');
  return h('div', { class: `set-row${stack ? ' stack' : ''}${compact ? ' compact' : ''}` },
    h('div', { class: 'set-text' },
      isField ? h('label', { class: 'set-label', id: labelId, for: control.id }, label) : h('div', { class: 'set-label', id: labelId }, label),
      hint && h('div', { class: 'set-hint' }, hint)),
    h('div', { class: 'set-control' }, control));
}
const card = (title, rows, foot) => h('div', { class: 'set-card' },
  title && h('div', { class: 'set-card-title' }, title), ...rows.flat().filter(Boolean), foot && h('div', { class: 'set-card-foot' }, foot));
const section = (id, title, desc, ...cards) => h('section', { class: 'set-section', id: `s-${id}`, 'aria-labelledby': `h-${id}` },
  h('header', { class: 'set-head' }, h('h2', { id: `h-${id}` }, title), desc && h('p', {}, desc)), ...cards);
// A switch with no visible text (the row's label names it)
const toggle = (checked, onChange) => {
  const el = switchEl('', checked, onChange);
  el.classList.add('switch-only');
  return el;
};
const loading = () => h('div', { class: 'skeleton', style: { height: '38px', width: '100%' } });
const failed = (e) => h('div', { class: 'callout warn' }, icon('triangle-alert'), h('div', {}, e.message));
const saved = (what) => toast(`${what} saved`);

// Thinking level select for a model
function thinkingSelect(getModel, key, fallback) {
  const sel = h('select', { class: 'select', onchange: () => { setPrefs({ [key]: sel.value }); saved('Thinking level'); } });
  sel.redraw = () => {
    const choices = reasoningChoices(getModel());
    sel.disabled = !choices.length;
    if (!choices.length) { sel.replaceChildren(h('option', {}, 'Not used by this model')); return; }
    const pick = reasoningSelection(choices, pref(key) || fallback);
    sel.replaceChildren(...choices.map((c) => h('option', { value: c, selected: c === pick }, REASONING_LABELS[c] || c)));
  };
  return sel;
}

// Wrap a section's card in a form so Enter and password managers work
function asForm(onSubmit, el) {
  const form = h('form', { novalidate: true, class: 'set-form', onsubmit: (e) => { e.preventDefault(); onSubmit(); } });
  form.append(el);
  return form;
}

// ---------- page ----------
export async function renderSettings(page, { rebuildShell }) {
  const me = session.me;
  page.classList.add('settings-page');
  const highlight = (id) => navLinks.forEach((a) => a.setAttribute('aria-current', String(a.dataset.target === id)));
  let lockUntil = 0; // while a nav click scrolls, keep its item highlighted
  const scroller = page.closest('.main');
  const navLinks = SECTIONS.map((s) => h('a', { href: '#/settings', 'data-target': s.id, onclick: (e) => {
    e.preventDefault();
    highlight(s.id);
    lockUntil = Date.now() + 900;
    const target = page.querySelector(`#s-${s.id}`);
    const nav = e.currentTarget.parentElement;
    // Phones: the section bar is sticky at the top, so leave room for it
    const offset = getComputedStyle(nav).position === 'sticky' && getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight + 12 : 24;
    if (target) scroller.scrollTo({ top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset, behavior: 'smooth' });
    nav.scrollTo({ left: e.currentTarget.offsetLeft - 16, behavior: 'smooth' });
  } }, icon(s.icon), h('span', { class: 'lbl' }, s.label), h('span', { class: 'short', 'aria-hidden': 'true' }, s.short || s.label)));
  navLinks[0].setAttribute('aria-current', 'true');

  const models = loadModels();
  page.replaceChildren(
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', {}, 'Settings'),
      h('p', {}, 'Saved to your account, so they follow you on every device.'))),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, navLinks),
      h('div', { class: 'set-sections' },
        profileSection(me, rebuildShell), appearanceSection(), liveSection(models), chatSection(models),
        voiceSection(models), advancedSection(models), usageSection(me), passwordSection())));

  // Highlight the section being read: the last one whose top has passed the upper part of the screen,
  // or the last section when scrolled to the bottom (short last sections never reach the top)
  const sections = [...page.querySelectorAll('.set-section')];
  let frame = 0;
  const onScroll = () => {
    if (!page.isConnected) { scroller.removeEventListener('scroll', onScroll); return; }
    if (Date.now() < lockUntil || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
      const current = atBottom ? sections[sections.length - 1] : sections.filter((s) => s.getBoundingClientRect().top <= line).pop() || sections[0];
      const id = current.id.replace('s-', '');
      highlight(id);
      // Phones: keep the active section visible in the scrolling bar
      const a = navLinks.find((x) => x.dataset.target === id);
      const nav = a?.parentElement;
      if (nav && nav.scrollWidth > nav.clientWidth) {
        const left = a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2;
        if (Math.abs(nav.scrollLeft - left) > 40) nav.scrollTo({ left, behavior: 'smooth' });
      }
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
}

// ---------- profile ----------
function profileSection(me, rebuildShell) {
  const name = h('input', { class: 'input', value: me.name, autocomplete: 'name' });
  const username = h('input', { class: 'input', value: me.username, disabled: true });
  const profile = h('textarea', { class: 'textarea', rows: '3', placeholder: 'e.g. Quantity Surveyor in the GCC, QS & Construction pathway, consultant side, 6 years experience' }, me.profile);
  const notes = h('textarea', { class: 'textarea', rows: '8', placeholder: 'Key facts for the assistant: experience per competency, project values and dates, CPD, ethics examples…' }, me.notes);
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
  return section('profile', 'Profile', 'The assistant uses this to answer as you.',
    asForm(submit, card(null, [
      row('Name', null, name),
      row('Username', 'Ask an admin to change it.', username),
      row('About you', 'Your role, region and pathway. Answers follow your region’s practice, e.g. GCC: FIDIC and POMI.', profile, { stack: true }),
      row('Notes', 'Short facts that are not in your documents. Long documents belong in My case study.', notes, { stack: true }),
    ], save)));
}

// ---------- appearance ----------
function appearanceSection() {
  const theme = segmented([
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
    { value: 'system', label: 'System', icon: 'monitor' },
  ], pref('theme'), (v) => { setPrefs({ theme: v }); applyTheme(v); }, 'Colour theme');

  const slider = (key, min, max, label, sample) => {
    const out = h('output', { class: 'set-value' }, `${pref(key)}px`);
    const preview = h('div', { class: 'preview', style: { fontSize: `${pref(key)}px`, lineHeight: '1.5' } }, sample);
    const input = h('input', { type: 'range', class: 'range', min, max, step: '1', value: pref(key), 'aria-label': `${label} text size`, oninput: () => {
      const v = Number(input.value);
      out.textContent = `${v}px`;
      preview.style.fontSize = `${v}px`;
      setPrefs({ [key]: v });
    } });
    return row(`${label} text size`, null, h('div', { class: 'set-slider' }, h('div', { class: 'set-slider-bar' }, input, out), preview), { stack: true });
  };

  return section('appearance', 'Appearance', 'Theme and text sizes. Text sizes can also be changed on the Live interview screen.',
    card(null, [
      row('Theme', 'System follows your device’s light or dark setting.', theme),
      slider('answerSize', 12, 36, 'Answer', h('div', {}, h('p', { style: { margin: '0 0 .4em' } }, 'NRM 1 sets rules for order of cost estimates and cost plans.'),
        h('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, h('li', {}, 'Elemental cost plans by RIBA stage'), h('li', {}, 'As a QS, I report cost movements to the client')))),
      slider('transcriptSize', 11, 30, 'Transcript', 'Can you talk me through how you prepared the elemental cost plan?'),
    ]));
}

// ---------- Live interview ----------
function liveSection(models) {
  const style = h('select', { class: 'select', onchange: () => { setPrefs({ answerStyle: style.value }); saved('Answer style'); } },
    ANSWER_STYLES.map((s) => h('option', { value: s.id, selected: s.id === pref('answerStyle'), 'data-hint': s.hint }, s.label)));
  const auto = toggle(pref('autoAnswer'), (v) => setPrefs({ autoAnswer: v }));
  const slots = [loading(), loading(), loading(), loading()];
  const el = section('live', 'Live interview', 'How questions heard in the meeting are detected and answered.',
    card('Answers', [
      row('Answer style', 'How answers are laid out. Also on the Live screen.', style),
      row('Answer automatically', 'Answer each question as soon as it is detected.', auto),
      row('Answer model', 'Writes the answers. Stronger models are more accurate but slower.', slots[0]),
      row('Thinking level', 'Higher is more careful but slower.', slots[1]),
    ]),
    card('Listening', [
      row('Speech-to-text', 'Turns the assessors’ speech into text. English only.', slots[2]),
      row('Question detection', 'Fast, cheap model. With fast decisions on, it only tidies questions.', slots[3]),
    ]));
  models.then((data) => {
    const d = data.defaults;
    const chosen = (k, def) => pref(k) || def;
    const thinking = thinkingSelect(() => data.answer.find((m) => m.id === chosen('answerModel', d.answerModel)), 'reasoning', d.reasoning);
    const answer = combobox({
      items: chatItems(data.answer, d.answerModel), value: chosen('answerModel', d.answerModel), ariaLabel: 'Answer model',
      placeholder: 'Search 380+ models, e.g. claude, gpt, gemini…',
      onChange: (v) => { setPrefs({ answerModel: v, reasoning: '' }); thinking.redraw(); saved('Answer model'); },
    });
    const stt = combobox({
      items: sttItems(data.stt, d.sttModel), value: chosen('sttModel', d.sttModel), ariaLabel: 'Speech-to-text model',
      placeholder: 'Search speech-to-text models…', onChange: (v) => { setPrefs({ sttModel: v }); saved('Speech-to-text model'); },
    });
    const detect = combobox({
      items: chatItems(data.answer, d.detectModel), value: chosen('detectModel', d.detectModel), ariaLabel: 'Question detection model',
      placeholder: 'Search models…', onChange: (v) => { setPrefs({ detectModel: v }); saved('Detection model'); },
    });
    thinking.redraw();
    [answer, thinking, stt, detect].forEach((c, i) => slots[i].replaceWith(c));
    el.reset = () => { answer.setValue(d.answerModel); stt.setValue(d.sttModel); detect.setValue(d.detectModel); thinking.redraw(); style.value = pref('answerStyle'); };
  }).catch((e) => slots[0].replaceWith(failed(e)));
  return el;
}

// ---------- Chat ----------
function chatSection(models) {
  const slots = [loading(), loading()];
  const el = section('chat', 'Chat', 'The study chat has its own model, separate from Live interview answers.',
    card(null, [
      row('Chat model', 'Writes chat answers from your documents.', slots[0]),
      row('Thinking level', 'Higher is more careful but slower.', slots[1]),
    ]));
  models.then((data) => {
    const d = data.defaults;
    const current = () => pref('chatModel') || d.answerModel;
    const thinking = thinkingSelect(() => data.answer.find((m) => m.id === current()), 'chatReasoning', d.reasoning);
    const model = combobox({
      items: chatItems(data.answer, d.answerModel), value: current(), ariaLabel: 'Chat model', placeholder: 'Search models…',
      onChange: (v) => { setPrefs({ chatModel: v, chatReasoning: '' }); thinking.redraw(); saved('Chat model'); },
    });
    thinking.redraw();
    slots[0].replaceWith(model);
    slots[1].replaceWith(thinking);
    el.reset = () => { model.setValue(d.answerModel); thinking.redraw(); };
  }).catch((e) => slots[0].replaceWith(failed(e)));
  return el;
}

// ---------- Voice ----------
function voiceSection(models) {
  const pause = segmented([
    { value: 'short', label: 'Short' }, { value: 'normal', label: 'Normal' }, { value: 'long', label: 'Long' },
  ], pref('voicePause') || 'normal', (v) => { setPrefs({ voicePause: v }); saved('Pause length'); }, 'Pause before sending');
  const interrupt = toggle(pref('voiceInterrupt') !== false, (v) => setPrefs({ voiceInterrupt: v }));
  const autoSend = toggle(pref('voiceAutoSend') !== false, (v) => setPrefs({ voiceAutoSend: v }));
  const slots = [loading(), loading(), loading(), loading(), loading()];
  const el = section('voice', 'Voice', 'Talk with the AI hands-free on the Chat page, and practise mock interviews out loud.',
    card('Listening', [
      row('Voice input model', 'Turns your speech into text. Accurate models with RICS word hints work best.', slots[0]),
      row('Pause before sending', 'How long you can pause before your turn is sent. Mock interviews always use Long.', pause),
      row('Interrupt by speaking', 'Talk over the AI to stop it. Best with headphones; tapping the circle also works.', interrupt),
      row('Send automatically', 'Off: check the text of each turn before it is sent.', autoSend),
    ]),
    card('Replies', [
      row('Reply model', 'Answers in voice mode. A fast model makes replies start sooner.', slots[1]),
      row('Thinking level', 'Off gives the quickest replies.', slots[2]),
      row('Voice model', 'Reads the replies aloud. Cheaper voices sound more robotic.', slots[3]),
      row('Voice', null, slots[4]),
    ]));
  Promise.all([models, api('GET', '/api/voices')]).then(([data, voices]) => {
    const vd = voices.defaults;
    const chosen = (k, def) => pref(k) || def;
    const sttModel = combobox({
      items: sttItems(data.stt, vd.voiceSttModel), value: chosen('voiceSttModel', vd.voiceSttModel), ariaLabel: 'Voice input model',
      placeholder: 'Search speech-to-text models…', onChange: (v) => { setPrefs({ voiceSttModel: v }); saved('Voice input model'); },
    });
    const thinking = thinkingSelect(() => data.answer.find((m) => m.id === chosen('voiceChatModel', vd.voiceChatModel)), 'voiceReasoning', 'none');
    const replyModel = combobox({
      items: chatItems(data.answer, vd.voiceChatModel), value: chosen('voiceChatModel', vd.voiceChatModel), ariaLabel: 'Reply model',
      placeholder: 'Search models…', onChange: (v) => { setPrefs({ voiceChatModel: v, voiceReasoning: '' }); thinking.redraw(); saved('Reply model'); },
    });
    const tts = voices.models.filter((m) => m.perChar > 0 || m.price === 'Free');
    let model = voices.current.model;
    const voiceSel = h('select', { class: 'select', onchange: () => { setPrefs({ voiceName: voiceSel.value }); saved('Voice'); } });
    const fillVoices = (selected) => {
      const list = englishFirst(tts.find((m) => m.id === model)?.voices || []);
      voiceSel.disabled = !list.length;
      voiceSel.replaceChildren(...(list.length ? list.map((v) => h('option', { value: v, selected: v === selected }, v)) : [h('option', { value: '' }, 'Default voice')]));
      if (list.length && !list.includes(selected)) voiceSel.value = list[0];
    };
    const voiceModel = combobox({
      items: tts.map((m) => ({
        value: m.id, label: m.name, sub: m.price, short: m.perChar ? `$${+(m.perChar * 1e6).toFixed(2)}/1M chars` : m.price,
        group: m.id === vd.voiceModel ? 'Default' : m.id.split('/')[0], tags: m.id === vd.voiceModel ? [{ text: 'Default', kind: 'accent' }] : [],
      })).sort((a, b) => (a.group === 'Default' ? -1 : b.group === 'Default' ? 1 : 0)),
      value: model, ariaLabel: 'Voice model', placeholder: 'Search voice models…',
      onChange: (v) => {
        model = v;
        fillVoices(v === vd.voiceModel ? vd.voiceName : '');
        setPrefs({ voiceModel: v, voiceName: voiceSel.value });
        saved('Voice model');
      },
    });
    fillVoices(voices.current.voice);
    const test = button('Test', { icon: 'volume-2', onClick: async () => {
      test.disabled = true;
      await flushPrefs(); // the server reads the voice from the saved settings
      try {
        const a = new Audio(`/api/speak?${new URLSearchParams({ t: 'Hello. In voice mode I read your answers aloud, for example: NRM 2 sets the rules for detailed measurement.' })}`);
        a.onerror = () => toast('Could not play this voice. Try another one.', 'error');
        await a.play();
      } catch (e) { toast(e.message, 'error'); } finally { test.disabled = false; }
    } });
    thinking.redraw();
    slots[0].replaceWith(sttModel);
    slots[1].replaceWith(replyModel);
    slots[2].replaceWith(thinking);
    slots[3].replaceWith(voiceModel);
    slots[4].replaceWith(h('div', { class: 'set-inline' }, voiceSel, test));
    el.reset = () => {
      sttModel.setValue(vd.voiceSttModel); replyModel.setValue(vd.voiceChatModel); voiceModel.setValue(vd.voiceModel);
      model = vd.voiceModel; fillVoices(vd.voiceName); thinking.redraw();
    };
  }).catch((e) => slots[0].replaceWith(failed(e)));
  return el;
}

// ---------- Advanced: fast decisions, reset ----------
function advancedSection(models) {
  const reset = button('Reset all models', { icon: 'eraser', onClick: () => {
    setPrefs({
      answerModel: '', reasoning: '', detectModel: '', sttModel: '', answerStyle: '', chatModel: '', chatReasoning: '',
      voiceSttModel: '', voiceChatModel: '', voiceReasoning: '', voiceModel: '', voiceName: '', knowledgeSttModel: '', knowledgeModel: '',
    });
    document.querySelectorAll('.set-section').forEach((s) => s.reset?.());
    toast('All models reset to the defaults');
  } });
  const slot = loading();
  const audioSlots = [loading(), loading()];
  const el = section('advanced', 'Advanced', null,
    card('Audio knowledge files', [
      row('Transcription model', 'Turns uploaded recordings into text. Low cost, with RICS word hints.', audioSlots[0]),
      row('Notes model', 'Organises the transcript into notes with headings, using only what was said. A cheap model is enough.', audioSlots[1]),
    ]),
    card(null, [
      row('Fast decisions (Jev 1.14)', h('span', {},
        'Decides in about 0.1 s whether speech is a question, picks the likely competency and source for searches, and skips searching for messages like “thanks”. ',
        h('span', { class: 'subtle' }, 'Uses typesafe/jev-1.14. If it fails, the app works as before.')), slot),
      row('Reset models', 'Go back to the default model, thinking level and voice everywhere.', reset),
    ]));
  models.then((data) => {
    const d = data.defaults;
    const stt = combobox({
      items: sttItems(data.stt, d.knowledgeSttModel), value: pref('knowledgeSttModel') || d.knowledgeSttModel, ariaLabel: 'Transcription model',
      placeholder: 'Search speech-to-text models…', onChange: (v) => { setPrefs({ knowledgeSttModel: v }); saved('Transcription model'); },
    });
    const notes = combobox({
      items: chatItems(data.answer, d.knowledgeModel), value: pref('knowledgeModel') || d.knowledgeModel, ariaLabel: 'Notes model',
      placeholder: 'Search models…', onChange: (v) => { setPrefs({ knowledgeModel: v }); saved('Notes model'); },
    });
    audioSlots[0].replaceWith(stt);
    audioSlots[1].replaceWith(notes);
    el.reset = () => { stt.setValue(d.knowledgeSttModel); notes.setValue(d.knowledgeModel); };
  }).catch((e) => audioSlots[0].replaceWith(failed(e)));
  models.then((data) => {
    const model = data.defaults.decisionModel;
    if (!model) { slot.replaceWith(h('span', { class: 'set-hint' }, 'Turned off on the server (DECISION_MODEL is empty).')); return; }
    const t = toggle(pref('useDecisions') !== false, (v) => { setPrefs({ useDecisions: v }); toast(v ? 'Fast decisions on' : 'Fast decisions off'); });
    t.querySelector('input').setAttribute('aria-label', 'Fast decisions');
    slot.replaceWith(t);
  }).catch(() => slot.replaceWith(h('span')));
  return el;
}

// ---------- usage ----------
function usageSection(me) {
  const body = h('div', { class: 'usage' }, h('div', { class: 'skeleton', style: { height: '160px' } }));
  let data = null;
  let period = 'month';
  const pick = segmented([{ value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }], period, (v) => { period = v; draw(); }, 'Period');
  const avg = (sum, n) => (n ? formatUsd(sum / n) : '–');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function draw() {
    const x = data[period];
    const cats = [
      { name: 'Live answers', icon: 'radio-tower', cost: x.answer, note: `${plural(x.answers, 'answer', 'answers')} · ${avg(x.answer, x.answers)} each` },
      { name: 'Chat', icon: 'messages-square', cost: x.chat, note: `${plural(x.chats, 'reply', 'replies')} · ${avg(x.chat, x.chats)} each · includes voice mode answers` },
      { name: 'Voice', icon: 'audio-lines', cost: x.voice, note: `${plural(x.voiceTurns, 'spoken turn', 'spoken turns')} · your speech to text, and replies read aloud` },
      { name: 'Live speech-to-text', icon: 'captions', cost: x.stt, note: 'The assessors’ speech in Live interview' },
      { name: 'Question detection', icon: 'text-search', cost: x.detect, note: 'Finding questions in Live interview' },
      { name: 'Audio knowledge files', icon: 'file-audio', cost: x.knowledge,
        note: `${plural(x.audioFiles || 0, 'recording', 'recordings')} · ${x.audioMinutes || 0} min · transcribed and organised into notes` },
    ];
    const max = Math.max(...cats.map((c) => c.cost), 0.000001);
    body.replaceChildren(
      h('div', { class: 'usage-top' },
        h('div', { class: 'usage-total' }, h('span', {}, period === 'month' ? 'Spent this month' : 'Spent in total'), h('b', {}, formatUsd(x.total))), pick),
      h('ul', { class: 'usage-list' }, cats.map((c) => h('li', {},
        h('span', { class: 'usage-icon' }, icon(c.icon)),
        h('div', { class: 'usage-text' }, h('b', {}, c.name), h('span', {}, c.note),
          h('div', { class: 'usage-bar', 'aria-hidden': 'true' }, c.cost > 0 && h('i', { style: { width: `${Math.max(1, Math.round((c.cost / max) * 100))}%` } }))),
        h('span', { class: 'usage-cost' }, formatUsd(c.cost))))));
  }
  api('GET', '/api/me/usage').then((u) => { data = u; draw(); }).catch((e) => body.replaceChildren(failed(e)));
  const key = me.role === 'admin' && h('div', { class: 'set-card-foot usage-key' }, icon('wallet'), h('span', {}, 'Loading OpenRouter account…'));
  if (key) {
    api('GET', '/api/key-usage').then((k) => {
      key.lastChild.textContent = typeof k.usage === 'number'
        ? `OpenRouter key: ${formatUsd(k.usage)} used in total${k.limit == null ? ', no spending limit set.' : `, ${formatUsd(k.limitRemaining)} left of ${formatUsd(k.limit)}.`}`
        : 'OpenRouter key usage is not available.';
    }).catch(() => { key.lastChild.textContent = 'OpenRouter key usage is not available.'; });
  }
  return section('usage', 'Usage & cost', 'Real amounts charged by OpenRouter for your account, in US dollars.',
    h('div', { class: 'set-card' }, body, key));
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
  return section('security', 'Password', 'At least 8 characters. Changing it signs out your other devices.',
    asForm(submit, card(null, [
      // Hidden username so password managers know which account this is
      h('input', { type: 'text', autocomplete: 'username', value: session.me.username, hidden: true, readonly: true, 'aria-hidden': 'true', tabindex: '-1' }),
      row('Current password', null, current),
      row('New password', null, next),
      row('Confirm new password', null, confirm),
    ], save)));
}
