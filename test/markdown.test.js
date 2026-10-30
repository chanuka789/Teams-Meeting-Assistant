import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, citedNumbers } from '../public/js/markdown.js';

test('inline: bold, italic, code and citations', () => {
  assert.deepEqual(parseInline('The **cost limit** is *fixed* `NRM 1` [2][3] and [4, 5].'), [
    { t: 'text', v: 'The ' }, { t: 'b', v: 'cost limit' }, { t: 'text', v: ' is ' }, { t: 'i', v: 'fixed' },
    { t: 'text', v: ' ' }, { t: 'code', v: 'NRM 1' }, { t: 'text', v: ' ' }, { t: 'cite', v: 2 }, { t: 'cite', v: 3 },
    { t: 'text', v: ' and ' }, { t: 'cite', v: 4 }, { t: 'cite', v: 5 }, { t: 'text', v: '.' },
  ]);
  assert.deepEqual(parseInline('5 * 3 = 15'), [{ t: 'text', v: '5 * 3 = 15' }]);
});

test('blocks: heading, paragraph, lists, table, quote, code', () => {
  const b = parseMarkdown('### Title\nLine one\nline two\n\n- a [1]\n- b\n\n1. x\n2. y\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> note\n\n```\ncode\n```');
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'ol', 'table', 'quote', 'code']);
  assert.equal(b[1].inline[0].v, 'Line one line two');
  assert.equal(b[2].items.length, 2);
  assert.deepEqual(b[4].rows[0].map((c) => c[0].v), ['1', '2']);
  assert.equal(b[6].text, 'code');
});

test('cited numbers in order of first use', () => {
  assert.deepEqual(citedNumbers('A [2]. B [1][2].\n- C [3]'), [2, 1, 3]);
});
