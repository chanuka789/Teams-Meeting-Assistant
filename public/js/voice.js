// Voice mode engine for the Chat page: hands-free spoken conversation.
// - Microphone (only while voice mode is on) -> speech detector; a pause (Settings: short / normal / long)
//   ends the turn, and the whole turn is transcribed at once by an accurate model with RICS vocabulary hints
// - The reply is spoken sentence by sentence while it is still being written; each sentence's audio streams,
//   so playback starts on its first bytes, and the next sentence loads while the current one plays
// - Talking over the reply interrupts it: the AI's own voice (echo) is measured and ignored; tapping the orb also works

import { SpeechSegmenter, BargeIn, rms, resample, encodeWav, bytesToBase64, TARGET_RATE } from '../audio.js';
import { speakable, takeChunks } from '../voice-text.js';
import { api } from './api.js';

// 0.1 s of silence, played on the first tap so mobile browsers allow audio playback afterwards
const SILENT_WAV = `data:audio/wav;base64,${bytesToBase64(encodeWav(new Float32Array(1600), TARGET_RATE))}`;
export const VOICE_PAUSES = { short: 600, normal: 900, long: 1500 };
const MAX_TURN_SECONDS = 150;

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------- spoken replies ----------
// Two <audio> players take turns: one plays while the other loads the next sentence. Both go through an
// analyser, so the session knows how loud the AI is right now (to tell the person's voice from echo).
function createSpeaker(ctx, { onStart, onIdle, onError }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  const players = [0, 1].map(() => {
    const a = new Audio();
    a.preload = 'auto';
    ctx.createMediaElementSource(a).connect(analyser);
    return a;
  });
  let queue = [];          // [{ text, player }]
  let current = null;      // the sentence playing now
  let final = false;
  let consumed = 0;        // characters of the speakable reply already queued
  let gen = 0;             // bumps on stop(), so late events are ignored
  let ids = { chatId: null, messageId: null };
  let errorShown = false;

  const urlFor = (text) => `/api/speak?${new URLSearchParams({ t: text, c: ids.chatId || '', m: ids.messageId || '' })}`;
  const freePlayer = () => players.find((p) => p !== current?.player && !queue.some((x) => x.player === p));
  // Give waiting sentences a free player, so their audio is already loading
  function prepare() {
    for (const item of queue) {
      if (item.player) continue;
      const p = freePlayer();
      if (!p) break;
      item.player = p;
      p.src = urlFor(item.text);
      p.load();
    }
  }
  function pump() {
    if (current) return;
    if (!queue.length) { if (final) { final = false; onIdle(); } return; }
    prepare();
    const item = queue.shift();
    current = item;
    const p = item.player;
    const my = gen;
    const next = () => {
      if (my !== gen) return;
      p.onended = p.onerror = null;
      current = null;
      pump();
    };
    p.onended = next;
    p.onerror = () => {
      if (!errorShown) { errorShown = true; onError(new Error('Could not play the voice. Try another voice in Settings.')); }
      next();
    };
    p.play().then(() => { if (my === gen) onStart(); }).catch(() => next());
    prepare();
  }
  return {
    unlock() { for (const p of players) { p.src = SILENT_WAV; p.play().catch(() => {}); } },
    begin(chatId) { this.stop(); ids = { chatId, messageId: null }; },
    setMessageId(id) { ids.messageId = id || null; },
    feed(markdown, isFinal) {
      const text = speakable(markdown, isFinal);
      if (text.length < consumed) consumed = text.length;
      // The first sentence goes out as soon as it is complete, later ones in longer, more natural chunks
      const { chunks, rest } = takeChunks(text.slice(consumed), isFinal, consumed === 0 ? 12 : 60);
      consumed = text.length - rest.length;
      for (const c of chunks) queue.push({ text: c, player: null });
      if (isFinal) final = true;
      pump();
      prepare();
    },
    // How loud the AI's voice is right now (RMS of the last ~20 ms)
    outLevel() {
      if (!current) return 0;
      analyser.getFloatTimeDomainData(buf);
      return rms(buf);
    },
    stop() {
      gen++;
      queue = [];
      current = null;
      final = false;
      consumed = 0;
      for (const p of players) {
        p.onended = p.onerror = null;
        p.pause();
        p.removeAttribute('src');
        p.load(); // stops the download too
      }
    },
    get busy() { return Boolean(current) || queue.length > 0; },
  };
}

// ---------- the voice session ----------
// opts: { mode: 'chat' | 'mock', pause: 'short'|'normal'|'long', interrupt, autoSend,
//         sendTurn(text) -> Promise (resolves when the reply has finished streaming), onInterrupt(),
//         onState(state, detail), onLevel(level, who: 'you' | 'ai'), onError(err) }
// States: listening, hearing, transcribing, review, thinking, speaking, paused
export async function startVoice(opts) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone.');
  // Created inside the tap, so phones allow sound
  const ctx = new AudioContext();
  ctx.resume().catch(() => {});
  let state = 'listening';
  const speaker = createSpeaker(ctx, {
    onStart: () => { if (state === 'thinking') set('speaking'); },
    onIdle: () => {
      guardUntil = performance.now() + 300; // the room's echo of the last words
      bargeIn.reset();
      recent.length = 0;
      if (state === 'speaking' || state === 'thinking') set('listening');
    },
    onError: (err) => opts.onError?.(err),
  });
  speaker.unlock();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await ctx.audioWorklet.addModule('/capture-worklet.js');
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);

  const pauseMs = () => Math.max(VOICE_PAUSES[opts.pause] || VOICE_PAUSES.normal, opts.mode === 'mock' ? VOICE_PAUSES.long : 0);
  let paused = false;
  let closed = false;
  let replyDone = true;    // the reply has finished streaming (speaking may continue)
  let silenced = false;    // the person interrupted or hushed this reply: speak no more of it
  let turn = [];           // audio of this turn (a long answer is cut into 30 s pieces)
  let turnStart = 0;
  let ticker = null;
  let guardUntil = 0;
  const recent = [];       // the last ~0.5 s of microphone audio while the AI speaks (start of an interruption)

  const segmenter = new SpeechSegmenter({
    sampleRate: ctx.sampleRate,
    silenceMs: pauseMs(),
    maxSegmentMs: 30000,
    minSpeechMs: 400,
    startFrames: 4,          // 80 ms of speech within 160 ms starts a turn (gaps between sounds allowed)
    startWindow: 8,
    onSegment: (samples, reason) => onSegment(samples, reason),
    onLevel: (level, inSpeech) => {
      opts.onLevel?.(level, 'you');
      if (inSpeech && !wasSpeech) onSpeechStart();
      wasSpeech = inSpeech;
    },
  });
  let wasSpeech = false;
  const bargeIn = new BargeIn();

  node.port.onmessage = (e) => {
    if (paused || closed) return;
    const frame = e.data;
    if (state === 'speaking') {
      // The AI is talking: only clear speech above its echo counts, and it interrupts the AI
      recent.push(frame);
      if (recent.length > 25) recent.shift();
      const out = speaker.outLevel();
      opts.onLevel?.(out, 'ai');
      if (opts.interrupt !== false && bargeIn.push(rms(frame), out)) interrupt();
      return;
    }
    if (performance.now() < guardUntil) return;
    if (state === 'transcribing' || state === 'review') return;
    segmenter.push(frame);
  };

  function set(s, detail) {
    state = s;
    clearInterval(ticker);
    if (s === 'hearing') {
      // Show how long the turn has been going (useful for long mock interview answers)
      const tick = () => opts.onState?.('hearing', fmt((performance.now() - turnStart) / 1000));
      ticker = setInterval(tick, 500);
      tick();
      return;
    }
    opts.onState?.(s, detail);
  }
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const busy = () => state === 'thinking' || state === 'speaking';

  function onSpeechStart() {
    if (state === 'listening') { turnStart = performance.now(); set('hearing'); }
  }

  function interrupt() {
    speaker.stop();
    silenced = true;
    bargeIn.reset();
    if (!replyDone) { opts.onInterrupt?.(); replyDone = true; }
    turn = [];
    turnStart = performance.now() - recent.length * 20;
    set('hearing');
    // Keep the words that started the interruption
    segmenter.reset();
    const keep = recent.splice(0);
    for (const f of keep) segmenter.push(f);
  }

  function onSegment(samples, reason) {
    if (paused || state === 'transcribing' || state === 'review') return;
    turn.push(samples);
    if (reason === 'max' && turn.length * 30 < MAX_TURN_SECONDS) return; // still talking: keep collecting
    endTurn();
  }

  async function endTurn() {
    const pieces = turn;
    turn = [];
    if (!pieces.length) { if (state === 'hearing') set('listening'); return; }
    // Spoke while the reply was still loading: drop that reply and answer this instead
    if (!replyDone) { speaker.stop(); opts.onInterrupt?.(); replyDone = true; }
    set('transcribing');
    const wav = encodeWav(resample(concat(pieces), ctx.sampleRate, TARGET_RATE), TARGET_RATE);
    let text = '';
    try {
      text = (await api('POST', '/api/voice/transcribe', { audio: bytesToBase64(wav), format: 'wav' })).text || '';
    } catch (err) {
      opts.onError?.(err);
    }
    if (closed) return;
    if (!text.trim()) { set('listening', 'Sorry, I did not catch that. Please say it again.'); return; }
    if (opts.autoSend === false) { set('review', text.trim()); return; }
    submit(text.trim());
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
    if (state === 'thinking' && !speaker.busy) set('listening');
  }

  set('listening');
  return {
    get state() { return state; },
    // Called by the chat page when a reply starts / streams / ends (typed messages are spoken too)
    replyStarted(chatId) {
      speaker.begin(chatId);
      replyDone = false;
      silenced = false;
      bargeIn.reset();
      if (state !== 'hearing') set('thinking');
    },
    replyText(markdown, final, messageId) {
      if (messageId) speaker.setMessageId(messageId);
      if (!silenced) speaker.feed(markdown, final);
      if (final) {
        replyDone = true;
        if (!speaker.busy && busy()) set('listening');
      }
    },
    replyFailed() { replyDone = true; speaker.stop(); if (busy()) set('listening'); },
    // "Done": end the turn now instead of waiting for the pause
    finishTurn() {
      if (state !== 'hearing') return;
      segmenter.flush('pause');
      if (state === 'hearing') endTurn();
    },
    // Tap the orb while the AI talks: stop it and listen
    tapInterrupt() {
      if (state !== 'speaking' && state !== 'thinking') return;
      speaker.stop();
      silenced = true;
      if (state === 'speaking') { guardUntil = performance.now() + 200; set('listening'); }
    },
    // Review (auto-send off)
    send(text) { if (text.trim()) submit(text.trim()); else set('listening'); },
    discard() { set('listening'); },
    setPaused(v) {
      paused = v;
      segmenter.reset();
      turn = [];
      if (v) set('paused'); else set(busy() ? state : 'listening');
    },
    setOptions(o) {
      Object.assign(opts, o);
      segmenter.silenceFrames = Math.round(pauseMs() / segmenter.frameMs);
    },
    stop() {
      closed = true;
      clearInterval(ticker);
      speaker.stop();
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
