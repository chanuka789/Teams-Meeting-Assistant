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
