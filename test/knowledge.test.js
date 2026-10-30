import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, chunkText } from '../lib/knowledge.js';
import { orQuery } from '../lib/documents.js';

test('tokenize drops stopwords and keeps numbers', () => {
  assert.deepEqual(tokenize('What is the retention under NRM 2? 5%'), ['retention', 'under', 'nrm', '2', '5%']);
});

test('chunkText splits long text with overlap', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about measurement.`).join(' ');
  const chunks = chunkText(text, 300, 60);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 360));
});

test('full-text OR query uses only safe keywords', () => {
  assert.equal(orQuery('What is the retention under NRM 2? 5%'), 'retention | under | nrm | 2 | 5');
  assert.equal(orQuery("Talk me through the client's cost & risk!"), 'client | cost | risk');
  assert.equal(orQuery('the and of'), '');
});

test('cited chunks are located in the original text, whitespace and overlaps included', async () => {
  const { locateChunks, mergeChunks } = await import('../lib/knowledge.js');
  const text = 'Project Falcon cost plan\n\nThe approved cost limit is AED 48.5 million.   Retention is 5%.\nVariations were valued at AED 1.2m.';
  const chunks = chunkText(text, 60, 20).map((t, i) => ({ id: i + 1, text: t }));
  const ranges = locateChunks(text, chunks);
  assert.equal(ranges.length, chunks.length);
  for (const r of ranges) {
    const original = text.slice(r.start, r.end).replace(/\s+/g, ' ');
    assert.equal(original, chunks[r.id - 1].text);
  }
  assert.deepEqual(locateChunks(text, [{ id: 9, text: 'not in the document' }]), []);
  const rebuilt = mergeChunks(chunks.map((c) => c.text));
  assert.ok(rebuilt.includes('AED 48.5 million'));
  assert.equal(locateChunks(rebuilt, chunks).length, chunks.length);
});
