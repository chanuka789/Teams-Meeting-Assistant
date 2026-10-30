// Live interview: capture meeting audio, transcribe, detect questions and stream answers.
// Created once and kept in memory, so listening continues while other pages are open.

import { SpeechSegmenter, resample, encodeWav, bytesToBase64, TARGET_RATE } from '../../audio.js';
import { splitCost, formatUsd } from '../../models.js';
import { h, icon, button, toast, announce, switchEl, sizeStepper, emptyState, openModal, timeStr } from '../ui.js';
import { api, apiStream } from '../api.js';
import { pref, setPrefs, onPrefsChange } from '../state.js';
import { createOverlay, parseAnswer, answerNodes } from './overlay.js';
import { ANSWER_STYLES } from '../format.js';

const ANSWER_DELAY_MS = 1200; // a question is often cut into several segments: wait for a short gap
const METER_BARS = 14;

export function createLivePage({ onListeningChange }) {
  const st = {
    running: false, stream: null, ctx: null, node: null, segmenter: null,
    segments: [],            // { time, text, el }
    pending: { parts: [], els: [], timer: null },
    answered: [],            // recent questions, so the detector skips repeats
    answers: [],             // { question, text } oldest first, shown in the floating window
    monthSpend: null,
    busy: 0,
  };

  // ---------- control bar ----------
  const startBtn = button('Start listening', { icon: 'mic', variant: 'primary', size: 'lg', onClick: () => start() });
  const stopBtn = button('Stop', { icon: 'circle-stop', variant: 'danger', size: 'lg', onClick: () => stop() });
  stopBtn.hidden = true;
  const pill = h('span', { class: 'status-pill', role: 'status' }, h('span', { class: 'dot' }), h('span', {}, 'Ready'));
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, Array.from({ length: METER_BARS }, () => h('i')));
  const spendValue = h('b', { class: 'num' }, '–');
  const spend = h('span', { class: 'spend', title: 'AI cost this month (speech-to-text, question detection and answers)' },
    icon('wallet'), 'This month', spendValue);
  const autoSwitch = switchEl('Auto-answer', pref('autoAnswer'), (v) => setPrefs({ autoAnswer: v }));
  const helpBtn = button('', { icon: 'circle-help', variant: 'ghost', ariaLabel: 'How to share Teams audio', onClick: showHelp });

  // Floating answers window (always on top, drag anywhere over the meeting)
  const overlay = createOverlay({
    getAnswers: () => st.answers,
    getStatus: () => (st.busy > 0 ? { text: 'Answering…', kind: 'busy' } : st.running ? { text: 'Listening', kind: 'live' } : { text: 'Ready', kind: '' }),
  });
  const floatBtn = button('Float answers', { icon: 'picture-in-picture-2', onClick: () => (overlay.isOpen() ? overlay.close() : overlay.open().catch((e) => toast(e.message, 'error'))) });
  floatBtn.title = 'Open the answers in a small window that stays on top of Teams. Drag it anywhere.';
  overlay.onOpenChange(() => {
    floatBtn.lastChild.textContent = overlay.isOpen() ? 'Close floating' : 'Float answers';
    floatBtn.setAttribute('aria-pressed', String(overlay.isOpen()));
  });

  const bar = h('div', { class: 'live-bar' },
    startBtn, stopBtn, pill, meter,
    h('span', { class: 'sep', 'aria-hidden': 'true' }), autoSwitch,
    h('span', { class: 'spacer' }), spend, floatBtn, helpBtn);

  // ---------- answers panel ----------
  const answersBody = h('div', { class: 'panel-body' });
  const answersList = h('div', { class: 'answers', 'aria-live': 'off' });
  const answersEmpty = emptyState({
    icon: 'sparkles', title: 'Answers will appear here',
    text: 'When an assessor asks a question, you get a short description and key points, using your case study and the competency library.',
  });
  answersBody.append(answersEmpty, answersList);
  const answerCount = h('span', { class: 'count num' });
  const askInput = h('input', { class: 'input', placeholder: 'Type a question to get an answer…', 'aria-label': 'Type a question', autocomplete: 'off' });
  const askForm = h('form', { class: 'ask', onsubmit: (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = '';
    getAnswer(q, 'typed');
  } },
    h('div', { class: 'input-icon' }, icon('message-square-text'), askInput),
    h('span', { class: 'kbd', title: 'Press / to focus', 'aria-hidden': 'true', style: { alignSelf: 'center' } }, '/'),
    button('Ask', { icon: 'send', variant: 'primary', type: 'submit' }));
  const styleSel = h('select', { class: 'select select-sm', 'aria-label': 'Answer style', title: 'Answer style (applies to the next answer)',
    onchange: () => setPrefs({ answerStyle: styleSel.value }) },
  ANSWER_STYLES.map((x) => h('option', { value: x.id, selected: x.id === pref('answerStyle'), title: x.hint }, x.label)));
  const answerSize = sizeStepper(pref('answerSize'), { min: 12, max: 36, label: 'answer', onChange: (v) => setPrefs({ answerSize: v }) });
  const answersPanel = h('section', { class: 'panel', 'aria-labelledby': 'answers-h' },
    h('div', { class: 'panel-head' },
      h('h2', { id: 'answers-h' }, icon('sparkles'), 'Answers'), answerCount,
      h('span', { class: 'spacer' }), styleSel, answerSize,
      button('', { icon: 'eraser', variant: 'ghost', size: 'sm', ariaLabel: 'Clear answers', onClick: clearAnswers })),
    askForm, answersBody);

  // ---------- transcript panel ----------
  const transcriptBody = h('div', { class: 'panel-body' });
  const lines = h('div', { class: 'transcript' });
  const transcriptEmpty = emptyState({
    icon: 'headphones', title: 'Listening to the assessors only',
    text: 'The app hears the meeting audio, never your microphone. Wear headphones.',
    extra: h('ol', { class: 'steps' },
      h('li', {}, h('span', {}, 'Click ', h('b', {}, 'Start listening'), '.')),
      h('li', {}, h('span', {}, h('b', {}, 'Teams app: '), 'choose ', h('b', {}, 'Entire screen'), ' and turn on ', h('b', {}, 'Share system audio'), '.')),
      h('li', {}, h('span', {}, h('b', {}, 'Teams in the browser: '), 'choose the Teams ', h('b', {}, 'tab'), ' and turn on ', h('b', {}, 'Share tab audio'), '.'))),
  });
  const jump = button('Jump to latest', { icon: 'arrow-down', size: 'sm', onClick: () => { transcriptBody.scrollTop = transcriptBody.scrollHeight; } });
  jump.classList.add('jump');
  transcriptBody.append(transcriptEmpty, lines, jump);
  transcriptBody.addEventListener('scroll', () => { if (nearBottom()) jump.classList.remove('show'); });
  const transcriptSize = sizeStepper(pref('transcriptSize'), { min: 11, max: 30, label: 'transcript', onChange: (v) => setPrefs({ transcriptSize: v }) });
  const transcriptPanel = h('section', { class: 'panel', 'aria-labelledby': 'transcript-h' },
    h('div', { class: 'panel-head' },
      h('h2', { id: 'transcript-h' }, icon('audio-lines'), 'Transcript'),
      h('span', { class: 'badge' }, 'Assessors only'),
      h('span', { class: 'spacer' }), transcriptSize,
      button('', { icon: 'copy', variant: 'ghost', size: 'sm', ariaLabel: 'Copy transcript', onClick: copyTranscript }),
      button('', { icon: 'eraser', variant: 'ghost', size: 'sm', ariaLabel: 'Clear transcript', onClick: clearTranscript })),
    transcriptBody);

  const el = h('div', { class: 'live' }, h('h1', { class: 'sr-only' }, 'Live interview'), bar,
    h('div', { class: 'live-grid' }, answersPanel, transcriptPanel));

  const applySizes = () => {
    el.style.setProperty('--answer-size', `${pref('answerSize')}px`);
    el.style.setProperty('--transcript-size', `${pref('transcriptSize')}px`);
  };
  applySizes();
  onPrefsChange((c) => {
    if ('answerSize' in c) answerSize.setValue(c.answerSize);
    if ('transcriptSize' in c) transcriptSize.setValue(c.transcriptSize);
    if ('autoAnswer' in c) autoSwitch.querySelector('input').checked = c.autoAnswer;
    if ('answerStyle' in c) styleSel.value = pref('answerStyle');
    applySizes();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && el.isConnected && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      askInput.focus();
    }
  });

  // ---------- helpers ----------
  function setStatus(text, kind = '') {
    pill.className = `status-pill ${kind}`.trim();
    pill.lastChild.textContent = text;
  }
  function refreshStatus() {
    if (st.busy > 0) setStatus('Answering…', 'busy');
    else if (st.running) setStatus('Listening', 'live');
    else setStatus('Ready');
    overlay.updateStatus();
  }
  function addSpend(cost) {
    if (typeof cost !== 'number' || st.monthSpend === null) return;
    st.monthSpend += cost;
    spendValue.textContent = formatUsd(st.monthSpend);
  }
  async function loadSpend() {
    try {
      const u = await api('GET', '/api/me/usage');
      st.monthSpend = u.month.total;
      spendValue.textContent = formatUsd(st.monthSpend);
    } catch { /* optional */ }
  }
  function showHelp() {
    openModal({
      title: 'Share the Teams audio',
      description: 'The app only hears what plays through your speakers or headphones, never your microphone.',
      body: [h('ol', { class: 'steps' },
        h('li', {}, h('span', {}, 'Open this app in ', h('b', {}, 'Chrome or Edge'), ' on a computer and wear headphones.')),
        h('li', {}, h('span', {}, 'Click ', h('b', {}, 'Start listening'), '. A sharing window opens.')),
        h('li', {}, h('span', {}, h('b', {}, 'Teams desktop app: '), 'choose ', h('b', {}, 'Entire screen'), ' and turn on ', h('b', {}, 'Share system audio'), '.')),
        h('li', {}, h('span', {}, h('b', {}, 'Teams in a browser tab: '), 'choose that ', h('b', {}, 'tab'), ' and turn on ', h('b', {}, 'Share tab audio'), '.')),
        h('li', {}, h('span', {}, 'Do not choose ', h('b', {}, 'Window'), ': browsers do not share audio from a single window.'))),
      h('div', { class: 'callout warn' }, icon('triangle-alert'), h('div', {}, 'Tell the assessors that an AI assistant is transcribing, and check that RICS assessment rules allow it.'))],
      actions: [{ label: 'Got it', variant: 'primary' }],
    });
  }

  // ---------- transcript ----------
  const nearBottom = () => transcriptBody.scrollHeight - transcriptBody.scrollTop - transcriptBody.clientHeight < 80;
  function addLine() {
    transcriptEmpty.remove();
    const stick = nearBottom();
    const line = h('div', { class: 'line pending' }, h('time', {}, timeStr()), h('span', {}, 'Transcribing…'));
    lines.append(line);
    if (stick) transcriptBody.scrollTop = transcriptBody.scrollHeight; else jump.classList.add('show');
    return line;
  }
  function fillLine(line, text) {
    if (!text) { line.remove(); return; }
    line.classList.remove('pending');
    line.lastChild.textContent = text;
    if (nearBottom()) transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }
  const recentTranscript = (max = 5000) => st.segments.map((s) => s.text).join('\n').slice(-max);
  async function copyTranscript() {
    const text = st.segments.map((s) => `[${timeStr(s.time)}] ${s.text}`).join('\n');
    if (!text) { toast('The transcript is empty.', 'info'); return; }
    try { await navigator.clipboard.writeText(text); toast('Transcript copied'); } catch { toast('Copy failed', 'error'); }
  }
  function clearTranscript() {
    st.segments = [];
    lines.replaceChildren();
    transcriptBody.prepend(transcriptEmpty);
  }

  // ---------- answers ----------
  function updateCount() {
    const n = answersList.children.length;
    answerCount.textContent = n ? `${n}` : '';
    if (!n && !answersEmpty.isConnected) answersBody.prepend(answersEmpty);
  }
  function clearAnswers() {
    answersList.replaceChildren();
    st.answers = [];
    overlay.update();
    updateCount();
  }

  function createCard(question, source) {
    answersEmpty.remove();
    answersList.querySelector('.answer.latest')?.classList.remove('latest');
    const qText = h('h3', {}, question);
    const body = h('div', { class: 'answer-a' }, h('div', { class: 'typing', 'aria-label': 'Writing answer' }, h('i'), h('i'), h('i')));
    const foot = h('div', { class: 'answer-foot' },
      h('time', {}, timeStr()),
      source === 'typed' ? h('span', { class: 'badge badge-warning' }, icon('pencil'), 'Typed') : h('span', { class: 'badge badge-success' }, icon('radio-tower'), 'Heard'));
    const copyBtn = button('Copy', { icon: 'copy', variant: 'ghost', size: 'sm', onClick: async () => {
      const text = [qText.textContent, ...[...body.querySelectorAll('p, li')].map((x) => (x.tagName === 'LI' ? '- ' : '') + x.textContent)].join('\n');
      try { await navigator.clipboard.writeText(text); toast('Answer copied'); } catch { toast('Copy failed', 'error'); }
    } });
    const card = h('article', { class: 'answer latest fresh' },
      h('div', { class: 'answer-q' }, h('span', { class: 'badge badge-accent' }, 'Q'), qText), body, foot);
    card.addSources = (sources) => {
      const spacer = h('span', { class: 'spacer' });
      foot.append(...sources.map((s) => (s.scope === 'case_study'
        ? h('span', { class: 'badge badge-case', title: 'From your case study' }, icon('folder-lock'), s.name)
        : h('span', { class: 'badge', title: 'From the competency library' }, icon('library'), s.name))), spacer, copyBtn);
    };
    card.render = (text) => renderAnswer(qText, body, text);
    answersList.prepend(card);
    answersBody.scrollTop = 0;
    updateCount();
    return card;
  }

  // "Q: …\nA:\n<description>\n- point" -> heading + paragraph + bullet list
  function renderAnswer(qText, body, text) {
    const { question, blocks } = parseAnswer(text);
    if (question) qText.textContent = question;
    if (blocks.length) body.replaceChildren(...answerNodes(blocks));
  }

  async function getAnswer(question, source) {
    const card = createCard(question, source);
    const entry = { question, text: '' };
    st.answers.push(entry);
    if (st.answers.length > 50) st.answers.shift();
    overlay.newAnswer();
    const show = (text) => { card.render(text); entry.text = text; overlay.update(); };
    st.busy++;
    refreshStatus();
    try {
      // Style is sent with the question, so a change just before asking is used straight away
      const res = await apiStream('/api/answer', { latest: question, source, transcript: recentTranscript(), style: pref('answerStyle') });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Answer failed');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        const { text } = splitCost(raw);
        if (/^\s*NONE\b/i.test(text)) continue;
        show(text);
      }
      const { text, cost, sources } = splitCost(raw);
      addSpend(cost);
      if (!text.trim() || /^\s*NONE\b/i.test(text)) {
        card.remove();
        st.answers = st.answers.filter((x) => x !== entry);
        overlay.update();
        updateCount();
        if (source === 'typed') toast('The AI returned no answer. Please try again.', 'error');
        return;
      }
      show(text);
      card.addSources(sources);
      announce(`New answer: ${card.querySelector('h3').textContent}`);
    } catch (err) {
      card.querySelector('.answer-a').replaceChildren(h('div', { class: 'callout warn' }, icon('triangle-alert'), h('div', {}, err.message)));
      card.addSources([]);
      entry.text = `Q: ${question}\nA:\n${err.message}`;
      overlay.update();
    } finally {
      setTimeout(() => card.classList.remove('fresh'), 400);
      st.busy--;
      refreshStatus();
    }
  }

  // ---------- question detection ----------
  async function detectAndAnswer(latest, lineEls) {
    let data;
    try {
      data = await api('POST', '/api/detect', { latest, transcript: recentTranscript(2500), answered: st.answered });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    addSpend(data.cost);
    if (!data.question) return;
    lineEls.forEach((l) => l.classList.add('question'));
    st.answered.push(data.question);
    if (st.answered.length > 5) st.answered.shift();
    getAnswer(data.question, 'detected');
  }

  function queueDetection(text, line) {
    st.pending.parts.push(text);
    st.pending.els.push(line);
    clearTimeout(st.pending.timer);
    st.pending.timer = setTimeout(() => {
      const latest = st.pending.parts.join(' ').trim();
      const els = st.pending.els;
      st.pending = { parts: [], els: [], timer: null };
      if (latest) detectAndAnswer(latest, els);
    }, ANSWER_DELAY_MS);
  }

  async function handleSegment(samples, sampleRate) {
    const wav = encodeWav(resample(samples, sampleRate, TARGET_RATE), TARGET_RATE);
    const line = addLine();
    try {
      const data = await api('POST', '/api/transcribe', { audio: bytesToBase64(wav), format: 'wav' });
      addSpend(data.cost);
      const text = (data.text || '').trim();
      fillLine(line, text);
      if (!text) return;
      st.segments.push({ time: new Date(), text });
      if (st.segments.length > 400) st.segments.shift();
      if (pref('autoAnswer')) queueDetection(text, line);
    } catch (err) {
      fillLine(line, '');
      toast(err.message, 'error');
    }
  }

  // ---------- audio capture (meeting output audio only, never the microphone) ----------
  async function start() {
    if (st.running) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('This browser cannot share audio. Use Chrome or Edge on a computer.', 'error');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 320, height: 180 }, // browsers require video; it is ignored
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Sharing was cancelled.' : `Could not capture audio: ${e.message}`, e.name === 'NotAllowedError' ? 'info' : 'error');
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      toast('No audio was shared. Start again and turn on "Share system audio" or "Share tab audio".', 'error');
      showHelp();
      return;
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/capture-worklet.js');
    const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    const node = new AudioWorkletNode(ctx, 'capture-processor');
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph running without playing audio back
    src.connect(node).connect(mute).connect(ctx.destination);

    const bars = [...meter.children];
    const segmenter = new SpeechSegmenter({
      sampleRate: ctx.sampleRate,
      onSegment: (samples) => handleSegment(samples, ctx.sampleRate),
      onLevel: (level, inSpeech) => {
        const lvl = Math.min(1, level * 9);
        bars.forEach((b, i) => {
          const shape = 0.55 + 0.45 * Math.sin((i / (METER_BARS - 1)) * Math.PI);
          b.style.height = `${Math.max(4, Math.round(26 * lvl * shape))}px`;
        });
        meter.classList.toggle('speech', inSpeech);
      },
    });
    node.port.onmessage = (e) => segmenter.push(e.data);
    stream.getTracks().forEach((t) => t.addEventListener('ended', () => stop()));

    Object.assign(st, { running: true, stream, ctx, node, segmenter });
    startBtn.hidden = true;
    stopBtn.hidden = false;
    meter.classList.add('on');
    refreshStatus();
    onListeningChange(true);
    stopBtn.focus();
  }

  function stop() {
    if (!st.running) return;
    st.running = false;
    try { st.segmenter?.flush(); } catch { /* ignore */ }
    st.stream?.getTracks().forEach((t) => t.stop());
    st.node?.disconnect();
    st.ctx?.close();
    Object.assign(st, { stream: null, ctx: null, node: null, segmenter: null });
    startBtn.hidden = false;
    stopBtn.hidden = true;
    meter.classList.remove('on', 'speech');
    [...meter.children].forEach((b) => { b.style.height = ''; });
    refreshStatus();
    onListeningChange(false);
  }

  return {
    el,
    stop,
    isListening: () => st.running,
    onShow() { loadSpend(); },
  };
}
