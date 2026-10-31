// Decision model client (Jev): request shape, parsing, fallbacks; routed search counts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY = 'test';
const { decide, decisionsOn, detectWithJev, routeQuestion, DECISIONS_URL } = await import('../lib/decisions.js');
const { routedCounts } = await import('../lib/documents.js');
const { buildTidyMessages, parseDetectReply } = await import('../lib/prompt.js');

const user = { id: 7, prefs: {} };
const realFetch = globalThis.fetch;
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (reply instanceof Error) throw reply;
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.body };
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test('decisions URL sits next to the /v1 base', () => {
  assert.equal(DECISIONS_URL, 'https://openrouter.ai/api/alpha/decisions');
});

test('decisions are on by default and can be switched off per user', () => {
  assert.equal(decisionsOn(user), true);
  assert.equal(decisionsOn({ id: 1, prefs: { useDecisions: false } }), false);
});

test('detectWithJev sends the state and two yes/no questions, and reads probabilities', async () => {
  const calls = stubFetch({ body: { answers: { is_question: { type: 'noul', noul: 0.93 }, needs_tidy: { type: 'noul', noul: 0.1 } }, usage: { cost: 0.00002 } } });
  const out = await detectWithJev(user, { latest: 'Talk me through NRM 2', transcript: 'Good morning', answered: [] });
  assert.equal(calls[0].body.model, 'typesafe/jev-1.14');
  assert.equal(calls[0].body.state.latest_speech, 'Talk me through NRM 2');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['is_question', 'needs_tidy']);
  assert.equal(calls[0].body.questions.is_question.type, 'noul');
  assert.equal(out.isQuestion, 0.93);
  assert.equal(out.needsTidy, 0.1);
  assert.equal(out.cost, 0.00002);
});

test('detectWithJev returns null on errors, so Haiku is used instead', async () => {
  stubFetch({ ok: false, status: 503, body: { error: { message: 'Provider overloaded' } } });
  assert.equal(await detectWithJev(user, { latest: 'x', transcript: '', answered: [] }), null);
  stubFetch(new Error('timeout'));
  assert.equal(await detectWithJev(user, { latest: 'x', transcript: '', answered: [] }), null);
  stubFetch({ body: { answers: {} } });
  assert.equal(await detectWithJev(user, { latest: 'x', transcript: '', answered: [] }), null);
});

test('no request at all when the user switched decisions off', async () => {
  const calls = stubFetch({ body: { answers: {} } });
  assert.equal(await decide({ id: 1, prefs: { useDecisions: false } }, 'detect', 'x', {}), null);
  assert.equal(calls.length, 0);
});

test('routeQuestion reads source and skip-search; low-confidence choices are ignored', async () => {
  const calls = stubFetch({ body: { answers: {
    source: { type: 'choice', choice: 'case_study', confidence: 0.8 },
    needs_documents: { type: 'noul', noul: 0.05 },
  }, usage: { cost: 0.00001 } } });
  const r = await routeQuestion(user, 'chat_extra', { question: 'thanks!' }, { withSkip: true });
  assert.ok(calls[0].body.questions.needs_documents);
  assert.equal(r.source, 'case_study');
  assert.equal(r.needsDocuments, 0.05);
  assert.equal(r.competencyId, null); // no competency list without a database
  stubFetch({ body: { answers: { source: { type: 'choice', choice: 'library', confidence: 0.2 } } } });
  assert.equal((await routeQuestion(user, 'answer_extra', { question: 'q' })).source, null);
});

test('routed search counts shift towards the likely source but never drop one to zero', () => {
  assert.deepEqual(routedCounts(null, 4, 5), [4, 5]);
  assert.deepEqual(routedCounts({ source: 'both' }, 4, 5), [4, 5]);
  assert.deepEqual(routedCounts({ source: 'case_study' }, 4, 5), [6, 3]);
  assert.deepEqual(routedCounts({ source: 'library' }, 4, 5), [2, 7]);
  assert.deepEqual(routedCounts({ source: 'library' }, 4, 6), [3, 7]);
});

test('tidy prompt asks for one QUESTION line and parses back', () => {
  const m = buildTidyMessages({ latest: 'talk me through pomie', transcript: 'ok so' });
  assert.match(m[0].content, /QUESTION:/);
  assert.match(m[1].content, /talk me through pomie/);
  assert.equal(parseDetectReply('QUESTION: Talk me through POMI.'), 'Talk me through POMI.');
});
