// Voice mode: speakable text, chunking for text-to-speech, voice models; mock interview and voice prompts
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, takeChunks } from '../public/voice-text.js';
import { toTtsModels, englishFirst } from '../public/models.js';
import { buildChatMessages, VOICE_STYLE, MOCK_SYSTEM } from '../lib/prompt.js';
import { BargeIn, SpeechSegmenter } from '../public/audio.js';

test('speakable drops citations, Markdown symbols, tables and links, and ends each line as a sentence', () => {
  const md = '### Cost limit\nThe approved **cost limit** was AED 48.5 million [1].\n\n- Retention is 5% under FIDIC [2]\n\n| a | b |\n|---|---|\n| x | y |\nSee [NRM 2](http://x) too.';
  assert.equal(speakable(md), 'Cost limit.\nThe approved cost limit was AED 48.5 million.\nRetention is 5% under FIDIC.\nSee NRM 2 too.');
});

test('while streaming, the unfinished last line gets no full stop yet', () => {
  assert.equal(speakable('Intro line\n- The approved cost', false), 'Intro line.\nThe approved cost');
  assert.equal(speakable('Intro line\n- The approved cost', true), 'Intro line.\nThe approved cost.');
});

test('takeChunks keeps unfinished sentences and decimals, joins short ones, and flushes at the end', () => {
  const r = takeChunks('Hi. Ok. This is the first full sentence here. And more', false);
  assert.deepEqual(r.chunks, ['Hi. Ok. This is the first full sentence here.']);
  assert.equal(r.rest, ' And more');
  // A sentence end at the very end only counts once the stream is final
  assert.deepEqual(takeChunks('The cost limit was AED 48.5 million.', false).chunks, []);
  assert.deepEqual(takeChunks('The cost limit was AED 48.5 million.', true).chunks, ['The cost limit was AED 48.5 million.']);
  // Very long sentences are cut at a comma or space
  const long = `${'word, '.repeat(80)}end`;
  const c = takeChunks(long, false).chunks;
  assert.ok(c.length >= 1 && c.every((x) => x.length <= 320));
});

test('streaming chunks add up to the same text as speaking it at once', () => {
  const md = 'NRM 2 sets the rules for detailed measurement [1]. It is used for bills of quantities.\n\n- First, measure the works.\n- Then, price them with rates [2].';
  let consumed = 0;
  const spoken = [];
  for (let n = 5; n <= md.length; n += 7) {
    const text = speakable(md.slice(0, n), false);
    const { chunks, rest } = takeChunks(text.slice(consumed), false);
    consumed = text.length - rest.length;
    spoken.push(...chunks);
  }
  const text = speakable(md, true);
  spoken.push(...takeChunks(text.slice(consumed), true).chunks);
  assert.equal(spoken.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('voice models: per-character prices and English voices first', () => {
  const [m] = toTtsModels([{ id: 'hexgrad/kokoro-82m', name: 'Kokoro', pricing: { prompt: '0.00000062' }, supported_voices: ['ef_dora', 'bm_george'] }]);
  assert.equal(m.perChar, 0.00000062);
  assert.equal(m.price, '$0.62 per 1M characters');
  assert.deepEqual(englishFirst(['de-DE-Grant:MAI', 'en-GB-Emily:MAI']), ['en-GB-Emily:MAI', 'de-DE-Grant:MAI']);
  assert.deepEqual(englishFirst(['ef_dora', 'bm_george', 'af_heart']), ['bm_george', 'af_heart', 'ef_dora']);
});

test('chat prompt: voice style, mock interview system prompt and focus', () => {
  const voice = buildChatMessages({ question: 'q', voice: true });
  assert.ok(voice[0].content.includes(VOICE_STYLE));
  const mock = buildChatMessages({ question: '[Start the mock interview]', mode: 'mock', focus: 'the competency "Contract practice"' });
  assert.ok(mock[0].content.startsWith(MOCK_SYSTEM));
  assert.match(mock[0].content, /Focus of this mock interview: the competency "Contract practice"/);
  assert.match(MOCK_SYSTEM, /ONE question at a time/);
  const plain = buildChatMessages({ question: 'q' });
  assert.match(plain[0].content, /Length:/);
  assert.doesNotMatch(plain[0].content, /Voice conversation/);
});

test('voice prompt tells the model the message is speech-to-text', () => {
  assert.match(VOICE_STYLE, /speech-to-text/);
  assert.match(VOICE_STYLE, /short first sentence/);
});

// Simulated AI voice: a level that rises and falls like speech
const aiLevel = (i) => 0.12 * (0.5 + 0.5 * Math.sin(i / 3));

test('barge-in: the AI voice echoing into the microphone does not interrupt', () => {
  const b = new BargeIn();
  let fired = false;
  for (let i = 0; i < 500; i++) {
    const out = aiLevel(i);
    const mic = out * 0.45 + Math.random() * 0.003; // strong echo (no headphones)
    if (b.push(mic, out)) fired = true;
  }
  assert.equal(fired, false);
});

test('barge-in: the person talking over the echo interrupts within about 0.3 s', () => {
  const b = new BargeIn();
  for (let i = 0; i < 200; i++) { const out = aiLevel(i); b.push(out * 0.45, out); } // learn the echo first
  let firedAt = -1;
  for (let i = 200; i < 260; i++) {
    const out = aiLevel(i);
    const speech = 0.15 * (0.6 + 0.4 * Math.sin(i)); // the person's voice, with syllable dips
    if (b.push(out * 0.45 + speech, out) && firedAt < 0) firedAt = i - 200;
  }
  assert.ok(firedAt >= 0 && firedAt <= 15, `fired after ${firedAt} frames`);
});

test('barge-in: with no echo (headphones) quiet speech still interrupts, room noise does not', () => {
  const b = new BargeIn();
  let fired = false;
  for (let i = 0; i < 300; i++) if (b.push(0.004, aiLevel(i))) fired = true; // quiet room
  assert.equal(fired, false);
  let n = 0;
  while (!b.push(0.05, aiLevel(n)) && n < 50) n++;
  assert.ok(n < 15);
});

test('segmenter says why a segment ended: a pause, or too long', () => {
  const ends = [];
  const s = new SpeechSegmenter({ sampleRate: 16000, silenceMs: 200, maxSegmentMs: 1000, onSegment: (_, r) => ends.push(r) });
  const loud = new Float32Array(320).fill(0.2);
  const quiet = new Float32Array(320);
  for (let i = 0; i < 70; i++) s.push(loud); // 1.4 s of speech: cut at 1 s
  for (let i = 0; i < 20; i++) s.push(quiet);
  assert.deepEqual(ends, ['max', 'pause']);
});
