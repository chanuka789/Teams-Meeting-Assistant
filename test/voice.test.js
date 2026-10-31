// Voice mode: speakable text, chunking for text-to-speech, voice models; mock interview and voice prompts
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, takeChunks } from '../public/voice-text.js';
import { toTtsModels, englishFirst } from '../public/models.js';
import { buildChatMessages, buildVoiceTidyMessages, VOICE_STYLE, MOCK_SYSTEM } from '../lib/prompt.js';

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

test('voice tidy prompt carries the transcript and context', () => {
  const m = buildVoiceTidyMessages('what is nrm to', 'Previous reply');
  assert.match(m[0].content, /corrected text only/);
  assert.match(m[1].content, /what is nrm to/);
  assert.match(m[1].content, /Previous reply/);
});
