// Voice mode engine for the Chat page: hands-free microphone turns and spoken replies.
// - Microphone (only while voice mode is on) -> speech detector (VAD) -> each pause is transcribed at once
// - A longer pause (or "Done") ends the turn: the whole turn is tidied once (technical terms) and sent
// - The reply is spoken sentence by sentence while it is still being written
// - Speaking while the reply plays interrupts it (optional)

import { SpeechSegmenter, resample, encodeWav, bytesToBase64, TARGET_RATE } from '../audio.js';
import { speakable, takeChunks } from '../voice-text.js';
import { api } from './api.js';

// 0.1 s of silence, played on the first tap so mobile browsers allow audio playback afterwards
const SILENT_WAV = `data:audio/wav;base64,${bytesToBase64(encodeWav(new Float32Array(1600), TARGET_RATE))}`;

// ---------- spoken replies ----------
// feed(markdown, final) as the reply streams; chunks are synthesised in order (two ahead) and played one by one.
function createSpeaker({ onStart, onIdle, onCost, onError }) {
  const audio = new Audio();
  audio.preload = 'auto';
  let queue = [];          // [{ text, p: Promise<url|null> }]
  let playing = false;
  let final = false;
  let consumed = 0;        // characters of the speakable text already queued
  let gen = 0;             // bumps on stop(), so late results are ignored
  let ids = { chatId: null, messageId: null };

  function synth(text, myGen) {
    return fetch('/api/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ text, chatId: ids.chatId, messageId: ids.messageId }),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Voice failed (${r.status})`);
      const cost = Number(r.headers.get('X-Cost'));
      const blob = await r.blob();
      if (myGen !== gen) return null;
      if (cost) onCost?.(cost, ids.messageId);
      return URL.createObjectURL(blob);
    }).catch((err) => { if (myGen === gen) onError?.(err); return null; });
  }
  function prefetch() {
    for (const item of queue.slice(0, 2)) if (!item.p) item.p = synth(item.text, gen);
  }
  function pump() {
    if (playing) return;
    if (!queue.length) { if (final) { final = false; onIdle?.(); } return; }
    prefetch();
    const myGen = gen;
    const item = queue[0];
    playing = true;
    item.p.then((url) => {
      if (myGen !== gen) return;
      queue.shift();
      if (!url) { playing = false; pump(); return; }
      audio.src = url;
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); if (myGen !== gen) return; playing = false; pump(); };
      audio.play().then(() => onStart?.()).catch(() => { playing = false; pump(); });
      prefetch();
    });
  }
  return {
    unlock() { audio.src = SILENT_WAV; audio.play().catch(() => {}); },
    begin(chatId) { this.stop(); ids = { chatId, messageId: null }; },
    setMessageId(id) { ids.messageId = id || null; },
    feed(markdown, isFinal) {
      const text = speakable(markdown, isFinal);
      if (text.length < consumed) consumed = text.length;
      const { chunks, rest } = takeChunks(text.slice(consumed), isFinal);
      consumed = text.length - rest.length;
      for (const c of chunks) queue.push({ text: c, p: null });
      if (isFinal) final = true;
      prefetch();
      pump();
    },
    stop() {
      gen++;
      queue = [];
      playing = false;
      final = false;
      consumed = 0;
      audio.pause();
      audio.removeAttribute('src');
    },
    get busy() { return playing || queue.length > 0; },
  };
}

// ---------- the voice session ----------
// opts: { mode: 'chat' | 'mock', sendTurn(text) -> Promise (resolves when the reply has finished streaming),
//         onInterrupt(), getContext() -> string, onState(state, detail), onLevel(level), interrupt: bool, autoSend: bool }
// States: listening, hearing, transcribing, review, thinking, speaking, paused
export async function startVoice(opts) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone.');
  const speaker = createSpeaker({
    onStart: () => set('speaking'),
    onIdle: () => { if (state === 'speaking' || state === 'thinking') set('listening'); },
    onCost: (c, messageId) => opts.onVoiceCost?.(c, messageId),
    onError: (err) => opts.onError?.(err),
  });
  speaker.unlock(); // inside the user's tap
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/capture-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);

  // A turn may have pauses: each pause sends that piece for transcription; a longer pause ends the turn
  const endPauseMs = opts.mode === 'mock' ? 2200 : 1100;
  let state = 'listening';
  let paused = false;
  let parts = [];          // Promise<string> per piece, in order
  let endTimer = null;
  let replyDone = true;    // the reply has finished streaming (speaking may continue)
  let silenced = false;    // the candidate interrupted or hushed this reply: speak no more of it
  let closed = false;

  const BASE_MIN = 0.006;
  const segmenter = new SpeechSegmenter({
    sampleRate: ctx.sampleRate,
    silenceMs: 700,
    maxSegmentMs: 25000,
    minSpeechMs: 300,
    onSegment: (samples) => onPiece(samples),
    onLevel: (level, inSpeech) => {
      opts.onLevel?.(level, inSpeech);
      if (inSpeech && !wasSpeech) onSpeechStart();
      wasSpeech = inSpeech;
    },
  });
  let wasSpeech = false;
  node.port.onmessage = (e) => { if (!paused && !closed) segmenter.push(e.data); };

  function set(s, detail) {
    state = s;
    // While the reply plays, the microphone needs louder, longer sound to count as speech (less echo)
    const replying = s === 'speaking' || s === 'thinking';
    // (at least 200 ms of loud sound within 360 ms, so a short noise or echo does not interrupt)
    segmenter.minThreshold = replying ? BASE_MIN * 4 : BASE_MIN;
    segmenter.startFrames = replying ? 10 : 3;
    segmenter.startWindow = replying ? 18 : 0;
    opts.onState?.(s, detail);
  }
  const busy = () => state === 'thinking' || state === 'speaking';

  function onSpeechStart() {
    clearTimeout(endTimer);
    if (busy()) {
      if (!opts.interrupt) return;
      // The candidate talks over the reply: stop it and listen
      speaker.stop();
      silenced = true;
      if (!replyDone) opts.onInterrupt?.();
      replyDone = true;
    }
    if (state !== 'review' && state !== 'transcribing') set('hearing', partialText());
  }

  let partials = [];
  const partialText = () => partials.filter(Boolean).join(' ');
  function onPiece(samples) {
    if (busy() && !opts.interrupt) return;
    if (state === 'review' || state === 'transcribing') return;
    const wav = encodeWav(resample(samples, ctx.sampleRate, TARGET_RATE), TARGET_RATE);
    const i = parts.length;
    const p = api('POST', '/api/transcribe', { audio: bytesToBase64(wav), format: 'wav' })
      .then((d) => { partials[i] = (d.text || '').trim(); if (state === 'hearing') opts.onState?.('hearing', partialText()); return partials[i]; })
      .catch((err) => { opts.onError?.(err); return ''; });
    parts.push(p);
    clearTimeout(endTimer);
    endTimer = setTimeout(endTurn, endPauseMs - 700);
  }

  async function endTurn() {
    clearTimeout(endTimer);
    if (!parts.length || state === 'transcribing' || state === 'review') return;
    const pieces = parts;
    parts = [];
    set('transcribing');
    const raw = (await Promise.all(pieces)).filter(Boolean).join(' ').trim();
    partials = [];
    if (closed) return;
    if (!raw) { set('listening'); return; }
    let text = raw;
    try {
      const d = await api('POST', '/api/voice/tidy', { text: raw, context: opts.getContext?.() || '' });
      if (d.text) text = d.text;
    } catch { /* keep what was heard */ }
    if (closed) return;
    if (opts.autoSend === false) { set('review', text); return; }
    submit(text);
  }

  async function submit(text) {
    set('thinking');
    replyDone = false;
    try {
      await opts.sendTurn(text);
    } catch (err) {
      opts.onError?.(err);
    }
    replyDone = true;
    // Nothing (left) to say: listen again
    if (state === 'thinking' && !speaker.busy) set('listening');
  }

  set('listening');
  return {
    speaker,
    get state() { return state; },
    // Called by the chat page when a reply starts / streams / ends
    replyStarted(chatId) { speaker.begin(chatId); replyDone = false; silenced = false; if (state !== 'speaking') set('thinking'); },
    replyText(markdown, final, messageId) {
      if (messageId) speaker.setMessageId(messageId);
      if (!silenced) speaker.feed(markdown, final);
      if (final) {
        replyDone = true;
        if (!speaker.busy && (state === 'thinking' || state === 'speaking')) set('listening');
      }
    },
    replyFailed() { replyDone = true; speaker.stop(); if (busy()) set('listening'); },
    // "Done": end the turn now instead of waiting for the pause
    finishTurn() { segmenter.flush(); setTimeout(endTurn, 30); },
    // Review (auto-send off)
    send(text) { if (text.trim()) submit(text.trim()); else set('listening'); },
    discard() { set('listening'); },
    // Stop the voice reply (keep listening)
    hush() { speaker.stop(); silenced = true; if (busy()) set('listening'); },
    setPaused(v) {
      paused = v;
      segmenter.reset();
      clearTimeout(endTimer);
      if (v) { parts = []; partials = []; set('paused'); } else set(busy() ? state : 'listening');
    },
    setOptions(o) { Object.assign(opts, o); },
    stop() {
      closed = true;
      clearTimeout(endTimer);
      speaker.stop();
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
