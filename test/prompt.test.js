import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnswerMessages, buildDetectMessages, parseDetectReply, isFillerOnly,
  isLikelyHallucination, isMostlyNonLatin, stripSoundTags,
} from '../lib/prompt.js';

test('filler-only speech is skipped, short real questions are not', () => {
  assert.ok(isFillerOnly('Mm-hmm. Mm-hmm. Mm-hmm.'));
  assert.ok(isFillerOnly('um Mm-hmm. Mm. Okay.'));
  assert.ok(!isFillerOnly('Define POMI?'));
  assert.ok(!isFillerOnly('Yeah, loud and clear.'));
});

test('English-only and sound-tag filters', () => {
  assert.ok(isMostlyNonLatin('ありがとうございます'));
  assert.ok(isMostlyNonLatin('شكرا جزيلا'));
  assert.ok(!isMostlyNonLatin('What is NRM 2 used for?'));
  assert.equal(stripSoundTags('Music Yes, I am here.'), 'Yes, I am here.');
  assert.equal(stripSoundTags('[Music] What is POMI?'), 'What is POMI?');
  assert.ok(isLikelyHallucination('[Music]'));
});

test('detect reply parsing', () => {
  assert.equal(parseDetectReply('QUESTION: What is the difference between NRM 1 and NRM 2?'),
    'What is the difference between NRM 1 and NRM 2?');
  assert.equal(parseDetectReply('NONE'), null);
  assert.equal(parseDetectReply(''), null);
});

test('detect and answer messages carry context', () => {
  const d = buildDetectMessages({ latest: 'and NRM 2?', transcript: 'What is the difference between NRM 1', answered: ['What is POMI?'] });
  assert.match(d[1].content, /already answered:\n- What is POMI\?/);
  const a = buildAnswerMessages({ latest: 'What was the cost limit?', source: 'detected', knowledge: [{ doc: 'falcon.pdf', text: 'Cost limit AED 48.5m' }] });
  assert.match(a[1].content, /\[falcon\.pdf\]\nCost limit AED 48\.5m/);
  assert.match(a[1].content, /The assessor asked this question \(always answer/);
});

test('floating window parses answers into description and points', async () => {
  const { parseAnswer } = await import('../public/js/format.js');
  const p = parseAnswer('Q: What is NRM 2?\nA:\nRICS rules for detailed measurement.\n- BOQs\n- Tender pricing');
  assert.equal(p.question, 'What is NRM 2?');
  assert.deepEqual(p.blocks, [{ type: 'p', text: 'RICS rules for detailed measurement.' }, { type: 'ul', items: ['BOQs', 'Tender pricing'] }]);
});
