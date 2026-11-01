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

test('each answer style has its own format rules', async () => {
  const { buildSystemPrompt, buildAnswerMessages } = await import('../lib/prompt.js');
  assert.match(buildSystemPrompt('points'), /No description line/);
  assert.match(buildSystemPrompt('brief'), /No bullet points/);
  assert.match(buildSystemPrompt('balanced'), /exactly 3-4 points/);
  assert.match(buildSystemPrompt('detailed'), /5-6 points/);
  assert.equal(buildSystemPrompt('unknown'), buildSystemPrompt('balanced'));
  assert.match(buildAnswerMessages({ latest: 'x', style: 'brief' })[0].content, /2-3 sentences/);
});

test('chat prompt carries numbered excerpts, history and length', async () => {
  const { buildChatMessages } = await import('../lib/prompt.js');
  const m = buildChatMessages({
    profile: 'QS in the GCC', excerpts: [{ n: 1, label: 'My case study · case.pdf', text: 'Cost limit AED 48.5m' }],
    history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }], question: 'What was the cost limit?', length: 'concise',
  });
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /\[1\] My case study · case\.pdf\nCost limit AED 48\.5m/);
  assert.match(m[0].content, /at most about 120 words/);
  assert.deepEqual(m.slice(1).map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m.at(-1).content, 'What was the cost limit?');
});

test('repeated questions are recognised, new follow-ups are not', async () => {
  const { isRepeatQuestion, buildTidyMessages } = await import('../lib/prompt.js');
  const answered = ['What is the RIBA Plan of Work?', 'What is NRM 2?'];
  assert.ok(isRepeatQuestion('Can you explain the RIBA Plan of Work?', answered));
  assert.ok(isRepeatQuestion('what is NRM 2', answered));
  assert.ok(!isRepeatQuestion('How did you use NRM 2 on your project?', answered));
  assert.ok(!isRepeatQuestion('What is POMI?', answered));
  assert.ok(!isRepeatQuestion('Anything?', []));
  const msgs = buildTidyMessages({ latest: 'Thanks, good.', transcript: 'x', answered });
  assert.match(msgs[1].content, /Questions already answered/);
  assert.match(msgs[0].content, /NONE/);
});

test('keywords style: one line of key terms, marked as fast', async () => {
  const { FAST_STYLES, ANSWER_STYLES } = await import('../public/js/format.js');
  assert.ok(ANSWER_STYLES.some((s) => s.id === 'keywords'));
  assert.ok(FAST_STYLES.has('keywords') && !FAST_STYLES.has('balanced'));
  const sys = buildAnswerMessages({ latest: 'x', style: 'keywords' })[0].content;
  assert.match(sys, /ONLY 5-8 keywords/);
  assert.match(sys, /<keyword> · <keyword>/);
});
