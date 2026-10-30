import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSegmenter, resample, encodeWav, rms } from '../public/audio.js';
import { isLikelyHallucination, isNoneReply, buildAnswerMessages } from '../lib/prompt.js';

const RATE = 48000;
const FRAME = RATE * 0.02;
const tone = (amp) => { const f = new Float32Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = amp * Math.sin(i / 5); return f; };
const silence = () => new Float32Array(FRAME);

test('segmenter emits one segment for speech followed by a pause', () => {
  const segs = [];
  const s = new SpeechSegmenter({ sampleRate: RATE, onSegment: (x) => segs.push(x) });
  for (let i = 0; i < 50; i++) s.push(silence());
  for (let i = 0; i < 100; i++) s.push(tone(0.2));  // 2 s speech
  for (let i = 0; i < 50; i++) s.push(silence());   // 1 s pause
  assert.equal(segs.length, 1);
  assert.ok(segs[0].length >= 100 * FRAME);
});

test('segmenter ignores short clicks', () => {
  const segs = [];
  const s = new SpeechSegmenter({ sampleRate: RATE, onSegment: (x) => segs.push(x) });
  for (let i = 0; i < 5; i++) s.push(tone(0.3));
  for (let i = 0; i < 60; i++) s.push(silence());
  assert.equal(segs.length, 0);
});

test('segmenter cuts long monologues', () => {
  const segs = [];
  const s = new SpeechSegmenter({ sampleRate: RATE, onSegment: (x) => segs.push(x), maxSegmentMs: 2000 });
  for (let i = 0; i < 250; i++) s.push(tone(0.2)); // 5 s
  assert.ok(segs.length >= 2);
});

test('resample and wav encode', () => {
  const x = new Float32Array(48000).fill(0.1);
  const y = resample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  const wav = encodeWav(y, 16000);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.ok(rms(x) > 0.09);
});

test('prompt helpers', () => {
  assert.ok(isLikelyHallucination('Thank you.'));
  assert.ok(!isLikelyHallucination('What is the total for the landscape package?'));
  assert.ok(isNoneReply('NONE'));
  assert.ok(!isNoneReply('Q: x\nA: y'));
  const m = buildAnswerMessages({ latest: 'When is handover?', transcript: '', notes: 'Handover June', role: '', manual: false });
  assert.equal(m[0].role, 'system');
  assert.match(m[1].content, /Handover June/);
});
