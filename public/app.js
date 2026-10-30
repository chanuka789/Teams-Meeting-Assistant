import { SpeechSegmenter, resample, encodeWav, bytesToBase64, TARGET_RATE } from './audio.js';

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
els.settingsBtn.onclick = () => els.settingsDialog.showModal();
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
  } catch { els.loginError.textContent = 'Could not reach the server.'; }
});

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
function createCard(manual) {
  els.answersEmpty?.remove();
  const card = document.createElement('div');
  card.className = 'card new' + (manual ? ' manual' : '');
  card.innerHTML = `<div class="q"></div><div class="a"></div>
    <div class="meta"><span class="when">${timeStr()}${manual ? ' · typed' : ''}</span>
    <button class="ghost small copy">Copy</button></div>`;
  card.querySelector('.copy').onclick = async () => {
    try { await navigator.clipboard.writeText(card.querySelector('.a').textContent); toast('Answer copied'); } catch { /* ignore */ }
  };
  els.answers.prepend(card);
  return card;
}
function renderCard(card, text) {
  const m = text.match(/^\s*Q:\s*(.*?)\s*(?:\n+\s*A:\s*([\s\S]*))?$/i);
  if (m) {
    card.querySelector('.q').textContent = m[1] || '';
    card.querySelector('.a').textContent = (m[2] || '').trim();
  } else {
    card.querySelector('.q').textContent = '';
    card.querySelector('.a').textContent = text.trim();
  }
}
els.clearAnswersBtn.onclick = () => { els.answers.innerHTML = ''; };

async function getAnswer(latest, manual = false) {
  const body = {
    latest,
    manual,
    transcript: recentTranscript(),
    notes: els.notesInput.value,
    role: els.roleInput.value,
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
  let text = '';
  let card = null;
  let decided = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (!decided) {
      const t = text.trimStart();
      if (t.length < 4 && 'NONE'.startsWith(t.toUpperCase())) continue; // still unsure
      if (/^NONE\b/i.test(t)) {                                        // no question
        reader.cancel();
        if (state.running) setStatus('Listening · no question detected', 'live');
        return;
      }
      decided = true;
      card = createCard(manual);
    }
    renderCard(card, text);
  }
  if (!decided && text.trim() && !/^\s*NONE/i.test(text)) { card = createCard(manual); renderCard(card, text); }
}

els.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.askInput.value.trim();
  if (!q) return;
  els.askInput.value = '';
  getAnswer(q, true);
});

// A question is often cut into several speech segments: wait for a short gap, then answer them together.
const ANSWER_DELAY_MS = 1200;
const pendingAnswer = { parts: [], timer: null };
function queueAutoAnswer(text) {
  pendingAnswer.parts.push(text);
  clearTimeout(pendingAnswer.timer);
  pendingAnswer.timer = setTimeout(() => {
    const latest = pendingAnswer.parts.join(' ');
    pendingAnswer.parts = [];
    if (latest.split(/\s+/).length >= 3) getAnswer(latest);
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
    const res = await api('/api/transcribe', { audio: bytesToBase64(wav), format: 'wav' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { fillSegment(div, ''); toast(data.error || 'Transcription failed', true); return; }
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
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('This browser cannot capture screen audio. Use Chrome or Edge on a computer.', true);
  }
  try {
    const cfg = await (await fetch('/api/config')).json();
    els.modelInfo.textContent = `Speech-to-text: ${cfg.sttModel} · Answers: ${cfg.answerModel}`;
    if (!cfg.keyConfigured) { setStatus('Server has no OpenRouter key', 'err'); toast('OPENROUTER_API_KEY is not set on the server yet.', true); }
    if (cfg.passwordRequired && !state.password) showLogin();
  } catch {
    setStatus('Server unreachable', 'err');
  }
})();
