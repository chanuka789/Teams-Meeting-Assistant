// Audio helpers: voice activity detection (VAD), resampling and WAV encoding.
// Pure functions/classes with no browser APIs, so they can be unit tested in Node.

export const TARGET_RATE = 16000;

export function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}

// Linear-interpolation resampler (good enough for speech recognition)
export function resample(input, fromRate, toRate = TARGET_RATE) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function concat(frames) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out;
}

/**
 * Energy-based VAD that cuts speech into segments.
 * Feed it fixed-size frames (e.g. 20 ms). It calls onSegment(Float32Array) when a
 * speaker pauses (silenceMs) or a segment reaches maxSegmentMs.
 */
export class SpeechSegmenter {
  constructor({
    sampleRate,
    frameMs = 20,
    onSegment,
    onLevel = () => {},
    minThreshold = 0.006,
    noiseFactor = 2.8,
    startFrames = 3,          // ~60 ms of loud audio to start
    startWindow = 0,          // >0: start when startFrames of the last startWindow frames are loud (gaps allowed)
    silenceMs = 650,          // pause length that ends a segment
    maxSegmentMs = 14000,     // force a cut on long monologues
    minSpeechMs = 350,        // ignore clicks / coughs
    preRollMs = 300,
  }) {
    Object.assign(this, { sampleRate, frameMs, onSegment, onLevel, minThreshold, noiseFactor, startFrames, startWindow });
    this.silenceFrames = Math.round(silenceMs / frameMs);
    this.maxFrames = Math.round(maxSegmentMs / frameMs);
    this.minSpeechFrames = Math.round(minSpeechMs / frameMs);
    this.preRollFrames = Math.round(preRollMs / frameMs);
    this.noise = minThreshold / 2;
    this.reset();
  }

  reset() {
    this.inSpeech = false;
    this.frames = [];
    this.preRoll = [];
    this.loudRun = 0;
    this.recent = [];
    this.quietRun = 0;
    this.speechFrames = 0;
  }

  threshold() {
    return Math.max(this.minThreshold, this.noise * this.noiseFactor);
  }

  push(frame) {
    const level = rms(frame);
    const thr = this.threshold();
    const loud = level > thr;
    this.onLevel(level, this.inSpeech);

    if (!this.inSpeech) {
      // Track background noise slowly while nobody is speaking
      if (!loud) this.noise = this.noise * 0.98 + level * 0.02;
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      // Optional window: speech dips between syllables, so count loud frames in the last startWindow frames
      let started = this.loudRun >= this.startFrames;
      if (this.startWindow > 0) {
        this.recent.push(loud);
        if (this.recent.length > this.startWindow) this.recent.shift();
        started = this.recent.filter(Boolean).length >= this.startFrames;
      }
      if (started) {
        this.inSpeech = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = Math.max(this.loudRun, this.recent.filter(Boolean).length);
        this.recent = [];
        this.quietRun = 0;
      }
      return;
    }

    this.frames.push(frame);
    if (loud) { this.speechFrames++; this.quietRun = 0; } else { this.quietRun++; }

    const ended = this.quietRun >= this.silenceFrames;
    const tooLong = this.frames.length >= this.maxFrames;
    if (ended || tooLong) this.flush();
  }

  flush() {
    if (this.inSpeech && this.speechFrames >= this.minSpeechFrames && this.frames.length) {
      this.onSegment(concat(this.frames));
    }
    this.reset();
  }
}
