import { SpeechSegmenter, resample, encodeWav, bytesToBase64, TARGET_RATE } from './audio.js';
import { reasoningChoices, splitCost, formatUsd } from './models.js';
import { buildIndex, search } from './knowledge.js';

const $ = (id) => document.getElementById(id);
const els = {
  statusDot: $('statusDot'), statusText: $('statusText'),
  startBtn: $('startBtn'), stopBtn: $('stopBtn'), settingsBtn: $('settingsBtn'),
  meterFill: $('meterFill'), meterHint: $('meterHint'),
  answers: $('answers'), answersEmpty: $('answersEmpty'), clearAnswersBtn: $('clearAnswersBtn'),
  askForm: $('askForm'), askInput: $('askInput'),
  transcript: $('transcript'), transcriptEmpty: $('transcriptEmpty'),
  copyTranscriptBtn: $('copyTranscriptBtn'), clearTranscriptBtn: $('clearTranscriptBtn'),
  settingsDialog: $('settingsDialog'), roleInput: $('roleInput'), notesInput: $('notesInput'),
  autoAnswerInput: $('autoAnswerInput'), modelInfo: $('modelInfo'), logoutBtn: $('logoutBtn'),
  answerModelSearch: $('answerModelSearch'), answerModelSelect: $('answerModelSelect'),
  reasoningSelect: $('reasoningSelect'), sttModelSelect: $('sttModelSelect'), resetModelsBtn: $('resetModelsBtn'),
  detectModelSelect: $('detectModelSelect'), docInput: $('docInput'), docList: $('docList'), docInfo: $('docInfo'),
  costBtn: $('costBtn'), costInfo: $('costInfo'), keyInfo: $('keyInfo'), resetCostBtn: $('resetCostBtn'),
  loginDialog: $('loginDialog'), loginForm: $('loginForm'), passwordInput: $('passwordInput'), loginError: $('loginError'),
  toast: $('toast'),
};

// ---------- local storage (wrapped: storage can be unavailable) ----------
const store = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  password: store.get('ma_password'),
  segments: [],       // { time, text }
  running: false,
  stream: null,
  ctx: null,
  node: null,
  segmenter: null,
  inflight: 0,
};

// ---------- UI helpers ----------
function setStatus(text, kind = '') {
  els.statusText.textContent = text;
  els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
}
let toastTimer;
function toast(msg, isErr = false) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (isErr ? ' err' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isErr ? 7000 : 3000);
}
const timeStr = (d = new Date()) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': state.password },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { showLogin('Wrong password.'); throw new Error('Not logged in'); }
  return res;
}
async function apiGet(path) {
  const res = await fetch(path, { headers: { 'x-app-password': state.password } });
  if (res.status === 401) { showLogin('Wrong password.'); throw new Error('Not logged in'); }
  return res;
}

// ---------- settings ----------
function loadSettings() {
  els.roleInput.value = store.get('ma_role');
  els.notesInput.value = store.get('ma_notes');
  els.autoAnswerInput.checked = store.get('ma_auto', '1') === '1';
}
function saveSettings() {
  store.set('ma_role', els.roleInput.value);
  store.set('ma_notes', els.notesInput.value);
  store.set('ma_auto', els.autoAnswerInput.checked ? '1' : '0');
}
function openSettings() {
  els.settingsDialog.showModal();
  loadModels();
  renderCost();
  loadKeyUsage();
}
els.settingsBtn.onclick = openSettings;
els.costBtn.onclick = openSettings;
els.settingsDialog.addEventListener('close', saveSettings);
els.logoutBtn.onclick = () => { store.del('ma_password'); state.password = ''; els.settingsDialog.close(); showLogin(); };

function showLogin(err = '') {
  els.loginError.textContent = err;
  if (!els.loginDialog.open) els.loginDialog.showModal();
  els.passwordInput.focus();
}
els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.password = els.passwordInput.value;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'x-app-password': state.password } });
    if (!r.ok) { els.loginError.textContent = 'Wrong password.'; return; }
    store.set('ma_password', state.password);
    els.loginDialog.close();
    toast('Unlocked');
    loadModels();
  } catch { els.loginError.textContent = 'Could not reach the server.'; }
});

// ---------- AI model choice ----------
// Empty stored value = use the server default.
const models = { answer: [], stt: [], defaults: null, loading: null };
const REASONING_LABELS = {
  none: 'Off (fastest)', minimal: 'Minimal', low: 'Low (fast)', medium: 'Medium',
  high: 'High (slower)', xhigh: 'Extra high (slow)', max: 'Max (slowest)',
};
const chosenAnswerModel = () => store.get('ma_answer_model') || models.defaults?.answerModel || '';
const chosenSttModel = () => store.get('ma_stt_model') || models.defaults?.sttModel || '';
const chosenDetectModel = () => store.get('ma_detect_model') || models.defaults?.detectModel || '';
const findModel = (list, id) => list.find((m) => m.id === id);

function price(m) {
  if (m.input == null || m.output == null) return '';
  if (m.input === 0 && m.output === 0) return 'free';
  return `$${m.input} in / $${m.output} out per 1M tokens`;
}
function sttPriceLabel(p) {
  if (!p) return 'price: see OpenRouter';
  if (p.perHour != null) return `$${p.perHour} per audio hour`;
  return price(p);
}

function loadModels() {
  if (models.answer.length) return Promise.resolve();
  models.loading ||= (async () => {
    try {
      const res = await apiGet('/api/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load models');
      Object.assign(models, data);
      // Forget choices that OpenRouter no longer offers
      if (store.get('ma_answer_model') && !findModel(models.answer, store.get('ma_answer_model'))) {
        store.del('ma_answer_model'); toast('Your chosen answer model is no longer available. Using the default.', true);
      }
      if (store.get('ma_detect_model') && !findModel(models.answer, store.get('ma_detect_model'))) {
        store.del('ma_detect_model'); toast('Your chosen question detection model is no longer available. Using the default.', true);
      }
      if (store.get('ma_stt_model') && !findModel(models.stt, store.get('ma_stt_model'))) {
        store.del('ma_stt_model'); toast('Your chosen speech-to-text model is no longer available. Using the default.', true);
      }
      renderModelPickers();
    } catch (e) {
      els.modelInfo.textContent = e.message;
    } finally {
      models.loading = null;
    }
  })();
  return models.loading;
}

// Fill a chat-model <select>, grouped by provider, optionally filtered by a search text
function fillChatModelSelect(select, current, defaultId, q = '') {
  const list = models.answer.filter((m) => !q || m.id === current
    || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  const groups = new Map();
  for (const m of list) {
    const provider = m.name.includes(':') ? m.name.split(':')[0] : m.id.split('/')[0];
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(m);
  }
  select.replaceChildren(...[...groups].map(([provider, items]) => {
    const g = document.createElement('optgroup');
    g.label = provider;
    for (const m of items) {
      const label = m.name.includes(':') ? m.name.split(':').slice(1).join(':').trim() : m.name;
      const tags = [price(m), m.id === defaultId ? 'default' : ''].filter(Boolean).join(' · ');
      g.append(new Option(tags ? `${label} — ${tags}` : label, m.id, false, m.id === current));
    }
    return g;
  }));
}
function renderAnswerOptions() {
  fillChatModelSelect(els.answerModelSelect, chosenAnswerModel(), models.defaults?.answerModel,
    els.answerModelSearch.value.trim().toLowerCase());
}
function renderDetectOptions() {
  fillChatModelSelect(els.detectModelSelect, chosenDetectModel(), models.defaults?.detectModel);
}

function renderReasoningOptions() {
  const choices = reasoningChoices(findModel(models.answer, chosenAnswerModel()));
  if (!choices.length) {
    els.reasoningSelect.replaceChildren(new Option('Not used by this model', ''));
    els.reasoningSelect.disabled = true;
    return;
  }
  els.reasoningSelect.disabled = false;
  const wanted = store.get('ma_reasoning') || models.defaults?.reasoning || 'low';
  const selected = choices.includes(wanted) ? wanted : choices.includes('low') ? 'low' : choices[choices.length - 1];
  els.reasoningSelect.replaceChildren(...choices.map((e) => new Option(REASONING_LABELS[e] || e, e, false, e === selected)));
}

function renderSttOptions() {
  const current = chosenSttModel();
  els.sttModelSelect.replaceChildren(...models.stt.map((m) =>
    new Option(`${m.name} — ${sttPriceLabel(m.price)}${m.id === models.defaults?.sttModel ? ' · default' : ''}`,
      m.id, false, m.id === current)));
}

function renderModelInfo() {
  const a = findModel(models.answer, chosenAnswerModel());
  const s = findModel(models.stt, chosenSttModel());
  const d = findModel(models.answer, chosenDetectModel());
  els.modelInfo.textContent = `${models.answer.length} chat models, ${models.stt.length} speech-to-text models. `
    + `Using: ${a?.name || chosenAnswerModel()} · detection ${d?.name || chosenDetectModel()} · ${s?.name || chosenSttModel()}`;
}

function renderModelPickers() {
  renderAnswerOptions();
  renderReasoningOptions();
  renderDetectOptions();
  renderSttOptions();
  renderModelInfo();
}

els.answerModelSearch.addEventListener('input', renderAnswerOptions);
els.answerModelSelect.addEventListener('change', () => {
  store.set('ma_answer_model', els.answerModelSelect.value);
  renderReasoningOptions();
  renderModelInfo();
});
els.reasoningSelect.addEventListener('change', () => store.set('ma_reasoning', els.reasoningSelect.value));
els.detectModelSelect.addEventListener('change', () => {
  store.set('ma_detect_model', els.detectModelSelect.value);
  renderModelInfo();
});
els.sttModelSelect.addEventListener('change', () => {
  store.set('ma_stt_model', els.sttModelSelect.value);
  renderModelInfo();
});
els.resetModelsBtn.onclick = () => {
  ['ma_answer_model', 'ma_stt_model', 'ma_reasoning', 'ma_detect_model'].forEach((k) => store.del(k));
  els.answerModelSearch.value = '';
  renderModelPickers();
  toast('Models reset to defaults');
};

// ---------- cost ----------
// Running total of what OpenRouter charged, kept in this browser until reset.
function readCost() {
  const empty = { stt: 0, detect: 0, answer: 0, answers: 0, since: Date.now() };
  try { return { ...empty, ...JSON.parse(store.get('ma_cost') || '{}') }; } catch {
    return empty;
  }
}
function addCost(kind, amount) {
  if (typeof amount !== 'number') return;
  const c = readCost();
  c[kind] += amount;
  if (kind === 'answer') c.answers += 1;
  store.set('ma_cost', JSON.stringify(c));
  renderCost();
}
function renderCost() {
  const c = readCost();
  const total = c.stt + c.detect + c.answer;
  els.costBtn.textContent = `Spent: ${formatUsd(total)}`;
  const avg = c.answers ? ` (avg ${formatUsd(c.answer / c.answers)} per AI reply)` : '';
  els.costInfo.textContent = `Since ${new Date(c.since).toLocaleString()}: speech-to-text ${formatUsd(c.stt)} · `
    + `question detection ${formatUsd(c.detect)} · answers ${formatUsd(c.answer)}${avg} · total ${formatUsd(total)}`;
}
async function loadKeyUsage() {
  els.keyInfo.textContent = '';
  try {
    const res = await apiGet('/api/usage');
    const u = await res.json();
    if (!res.ok || typeof u.usage !== 'number') return;
    const limit = u.limit == null ? 'no spending limit set' : `limit ${formatUsd(u.limit)}, ${formatUsd(u.limitRemaining)} left`;
    els.keyInfo.textContent = `Your OpenRouter key has used ${formatUsd(u.usage)} in total (${limit}).`;
  } catch { /* optional info */ }
}
els.resetCostBtn.onclick = () => {
  store.del('ma_cost');
  renderCost();
  toast('Cost counter reset');
};

// ---------- knowledge documents ----------
// Extracted text of the user's documents, kept in this browser's IndexedDB (too big for localStorage).
const docsDb = {
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('meeting-assistant', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'name' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const req = fn(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all() { return this.run('readonly', (s) => s.getAll()); },
  put(doc) { return this.run('readwrite', (s) => s.put(doc)); },
  del(name) { return this.run('readwrite', (s) => s.delete(name)); },
};
const knowledge = { docs: [], index: buildIndex([]) };

async function refreshDocs() {
  try { knowledge.docs = await docsDb.all(); } catch { knowledge.docs = []; }
  knowledge.index = buildIndex(knowledge.docs);
  renderDocs();
}
function renderDocs() {
  els.docList.replaceChildren(...knowledge.docs.map((d) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${d.name} — ${d.text.length.toLocaleString()} characters`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = 'Remove';
    del.onclick = async () => { await docsDb.del(d.name).catch(() => {}); await refreshDocs(); toast(`Removed ${d.name}`); };
    li.append(name, del);
    return li;
  }));
  const total = knowledge.docs.reduce((n, d) => n + d.text.length, 0);
  els.docInfo.textContent = knowledge.docs.length
    ? `${knowledge.docs.length} document(s), ${total.toLocaleString()} characters, ${knowledge.index.chunks.length} searchable passages.`
    : 'No documents yet.';
}
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
els.docInput.addEventListener('change', async () => {
  const files = [...els.docInput.files];
  els.docInput.value = '';
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is larger than 20 MB.`, true); continue; }
    els.docInfo.textContent = `Reading ${file.name}…`;
    try {
      const res = await api('/api/extract', { name: file.name, data: await fileToBase64(file) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast(`${file.name}: ${data.error || 'could not read the file'}`, true); continue; }
      await docsDb.put({ name: file.name, text: data.text, added: Date.now() });
      toast(`Added ${file.name} (${data.chars.toLocaleString()} characters)`);
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
  }
  await refreshDocs();
});
// The most relevant passages of the user's documents for a question
function findKnowledge(question) {
  return search(knowledge.index, question, { k: 6, maxChars: 6000 }).map(({ doc, text }) => ({ doc, text }));
}

// ---------- transcript ----------
function addPendingSegment() {
  els.transcriptEmpty?.remove();
  const div = document.createElement('div');
  div.className = 'seg pending';
  div.innerHTML = `<time>${timeStr()}</time><span>…transcribing</span>`;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}
function fillSegment(div, text) {
  if (!text) { div.remove(); return; }
  div.classList.remove('pending');
  div.querySelector('span').textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function recentTranscript(maxChars = 5000) {
  const lines = state.segments.map((s) => s.text);
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}
els.copyTranscriptBtn.onclick = async () => {
  const text = state.segments.map((s) => `[${timeStr(s.time)}] ${s.text}`).join('\n');
  try { await navigator.clipboard.writeText(text); toast('Transcript copied'); } catch { toast('Copy failed', true); }
};
els.clearTranscriptBtn.onclick = () => { state.segments = []; els.transcript.innerHTML = ''; };

// ---------- answers ----------
function createCard(manual, sources = []) {
  els.answersEmpty?.remove();
  const card = document.createElement('div');
  card.className = 'card new' + (manual ? ' manual' : '');
  card.innerHTML = `<div class="q"></div><div class="a"></div>
    <div class="meta"><span class="when">${timeStr()}${manual ? ' · typed' : ''}<span class="sources"></span></span>
    <button class="ghost small copy">Copy</button></div>`;
  if (sources.length) card.querySelector('.sources').textContent = ` · from: ${sources.join(', ')}`;
  card.querySelector('.copy').onclick = async () => {
    try { await navigator.clipboard.writeText([...card.querySelectorAll('.a p, .a li')]
      .map((x) => (x.tagName === 'LI' ? '- ' : '') + x.textContent).join('\n')); toast('Answer copied'); } catch { /* ignore */ }
  };
  els.answers.prepend(card);
  return card;
}
function renderCard(card, text) {
  const m = text.match(/^\s*Q:\s*(.*?)\s*(?:\n+\s*A:\s*([\s\S]*))?$/i);
  card.querySelector('.q').textContent = m ? m[1] || '' : '';
  const answer = (m ? m[2] || '' : text).trim();
  // Short description as paragraphs, "- " lines as a bullet list
  const nodes = [];
  let list = null;
  for (const raw of answer.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const point = line.match(/^[-•*]\s*(.*)$/);
    if (point) {
      if (!list) { list = document.createElement('ul'); nodes.push(list); }
      const li = document.createElement('li');
      li.textContent = point[1];
      list.append(li);
    } else {
      list = null;
      const p = document.createElement('p');
      p.textContent = line;
      nodes.push(p);
    }
  }
  card.querySelector('.a').replaceChildren(...nodes);
}
els.clearAnswersBtn.onclick = () => { els.answers.innerHTML = ''; };

// source: 'typed' (Ask box), 'detected' (question found in speech) or 'speech'
async function getAnswer(latest, source = 'speech') {
  const manual = source === 'typed';
  const docs = findKnowledge(latest);
  const sources = [...new Set(docs.map((d) => d.doc))];
  const body = {
    latest,
    source,
    knowledge: docs,
    transcript: recentTranscript(),
    notes: els.notesInput.value,
    role: els.roleInput.value,
    model: store.get('ma_answer_model') || undefined,
    reasoning: store.get('ma_reasoning') || undefined,
  };
  let res;
  try { res = await api('/api/answer', body); } catch (e) { return; }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    toast(data.error || 'Answer failed', true);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let card = null;
  let none = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (none) continue; // keep reading: the cost arrives at the end
    const { text } = splitCost(raw);
    if (!card) {
      const t = text.trimStart();
      if (t.length < 4 && 'NONE'.startsWith(t.toUpperCase())) continue; // still unsure
      if (/^NONE\b/i.test(t)) {                                        // no question
        none = true;
        if (state.running) setStatus('Listening · no question detected', 'live');
        continue;
      }
      card = createCard(manual, sources);
    }
    renderCard(card, text);
  }
  const { text, cost } = splitCost(raw);
  if (!card && !none && text.trim() && !/^\s*NONE/i.test(text)) { card = createCard(manual, sources); renderCard(card, text); }
  addCost('answer', cost);
  if (!text.trim()) toast('The AI returned an empty answer. Please try again.', true);
}

els.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.askInput.value.trim();
  if (!q) return;
  els.askInput.value = '';
  getAnswer(q, 'typed');
});

// Questions already answered, so the detector does not answer the same question twice
const answeredQuestions = [];

// A fast model checks whether the speech is a question and rebuilds the full question;
// only then is the (slower) answer model called.
async function detectAndAnswer(latest) {
  let res;
  try {
    res = await api('/api/detect', {
      latest,
      transcript: recentTranscript(2500),
      answered: answeredQuestions,
      model: store.get('ma_detect_model') || undefined,
    });
  } catch { return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'Question detection failed', true); return; }
  if (data.cost) addCost('detect', data.cost);
  if (!data.question) {
    if (!data.skipped && state.running) setStatus('Listening · no question detected', 'live');
    return;
  }
  answeredQuestions.push(data.question);
  if (answeredQuestions.length > 5) answeredQuestions.shift();
  if (state.running) setStatus('Listening · answering…', 'busy');
  getAnswer(data.question, 'detected');
}

// A question is often cut into several speech segments: wait for a short gap, then check them together.
const ANSWER_DELAY_MS = 1200;
const pendingAnswer = { parts: [], timer: null };
function queueAutoAnswer(text) {
  pendingAnswer.parts.push(text);
  clearTimeout(pendingAnswer.timer);
  pendingAnswer.timer = setTimeout(() => {
    const latest = pendingAnswer.parts.join(' ').trim();
    pendingAnswer.parts = [];
    if (latest) detectAndAnswer(latest);
  }, ANSWER_DELAY_MS);
}

// ---------- speech segment pipeline ----------
async function handleSegment(samples, sampleRate) {
  const pcm16k = resample(samples, sampleRate, TARGET_RATE);
  const wav = encodeWav(pcm16k, TARGET_RATE);
  const div = addPendingSegment();
  state.inflight++;
  setStatus('Listening · transcribing…', 'busy');
  try {
    const res = await api('/api/transcribe', {
      audio: bytesToBase64(wav), format: 'wav', model: store.get('ma_stt_model') || undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { fillSegment(div, ''); toast(data.error || 'Transcription failed', true); return; }
    addCost('stt', data.cost);
    const text = (data.text || '').trim();
    fillSegment(div, text);
    if (!text) return;
    state.segments.push({ time: new Date(), text });
    if (state.segments.length > 400) state.segments.shift();
    if (els.autoAnswerInput.checked) queueAutoAnswer(text);
  } catch (e) {
    fillSegment(div, '');
  } finally {
    state.inflight--;
    if (state.running) setStatus('Listening', 'live');
  }
}

// ---------- audio capture ----------
// Meeting (output) audio only, via screen / tab share. The microphone is never used.
async function getStream() {
  // Video is required by browsers but we ignore it.
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1, width: 320, height: 180 },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });
}

async function start() {
  if (state.running) return;
  let stream;
  try {
    stream = await getStream();
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Sharing was cancelled.' : 'Could not capture audio: ' + e.message, true);
    return;
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    toast('No audio was shared. Start again and tick "Share system audio" (Windows) or "Share tab audio".', true);
    return;
  }

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/capture-worklet.js');
  const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph running without playing audio back
  src.connect(node).connect(mute).connect(ctx.destination);

  const segmenter = new SpeechSegmenter({
    sampleRate: ctx.sampleRate,
    onSegment: (samples) => handleSegment(samples, ctx.sampleRate),
    onLevel: (level, inSpeech) => {
      els.meterFill.style.width = Math.min(100, level * 600) + '%';
      els.meterFill.classList.toggle('speech', inSpeech);
      els.meterHint.textContent = inSpeech ? 'Speech detected' : 'Listening';
    },
  });
  node.port.onmessage = (e) => segmenter.push(e.data);

  // Stop if the user ends sharing from the browser bar
  stream.getTracks().forEach((t) => t.addEventListener('ended', () => stop()));

  Object.assign(state, { running: true, stream, ctx, node, segmenter });
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  setStatus('Listening to meeting audio', 'live');
}

function stop() {
  if (!state.running) return;
  state.running = false;
  try { state.segmenter?.flush(); } catch { /* ignore */ }
  state.stream?.getTracks().forEach((t) => t.stop());
  state.node?.disconnect();
  state.ctx?.close();
  Object.assign(state, { stream: null, ctx: null, node: null, segmenter: null });
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.meterFill.style.width = '0';
  els.meterHint.textContent = 'Audio level';
  setStatus('Stopped');
}

els.startBtn.onclick = start;
els.stopBtn.onclick = stop;

// ---------- boot ----------
(async function boot() {
  loadSettings();
  renderCost();
  refreshDocs();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('This browser cannot capture screen audio. Use Chrome or Edge on a computer.', true);
  }
  try {
    const cfg = await (await fetch('/api/config')).json();
    els.modelInfo.textContent = `Default models: ${cfg.answerModel} · ${cfg.sttModel}`;
    if (!cfg.keyConfigured) { setStatus('Server has no OpenRouter key', 'err'); toast('OPENROUTER_API_KEY is not set on the server yet.', true); }
    if (cfg.passwordRequired && !state.password) showLogin();
    else if (cfg.keyConfigured) loadModels();
  } catch {
    setStatus('Server unreachable', 'err');
  }
})();
