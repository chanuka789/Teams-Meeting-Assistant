import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, chunkText, buildIndex, search } from '../public/knowledge.js';

test('tokenize drops stopwords and keeps numbers', () => {
  assert.deepEqual(tokenize('What is the retention under NRM 2? 5%'), ['retention', 'under', 'nrm', '2', '5%']);
});

test('chunkText splits long text with overlap', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about measurement.`).join(' ');
  const chunks = chunkText(text, 300, 60);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 360));
});

test('search ranks the relevant document first', () => {
  const index = buildIndex([
    { name: 'falcon.pdf', text: 'The approved cost limit for Project Falcon is AED 48.5 million. Retention is 5% under FIDIC.' },
    { name: 'ethics.docx', text: 'Conflicts of interest must be declared in writing and informed consent obtained.' },
    { name: 'nrm.txt', text: 'NRM 1 covers order of cost estimates and elemental cost plans.' },
  ]);
  const hits = search(index, 'How do you handle a conflict of interest?');
  assert.equal(hits[0].doc, 'ethics.docx');
  assert.equal(search(index, 'What was the cost limit on Falcon?')[0].doc, 'falcon.pdf');
  assert.deepEqual(search(index, 'the and of'), []);
});
