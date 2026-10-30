import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelId, toAnswerModels, toSttModels, reasoningChoices, reasoningParam } from '../public/models.js';

const raw = [
  {
    id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5',
    architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000002', completion: '0.00001' },
    supported_parameters: ['max_tokens', 'reasoning'],
    reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
  },
  {
    id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5',
    architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.0000001', completion: '0.0000005' },
    supported_parameters: ['reasoning'],
    reasoning: { mandatory: false, supported_efforts: ['high', 'medium', 'low', 'none'] },
  },
  { id: 'anthropic/claude-haiku-5.5:batch', name: 'Anthropic: Claude Haiku 5.5 (batch)', architecture: { output_modalities: ['text'] } },
  { id: 'some/image-model', name: 'Some: Image', architecture: { output_modalities: ['image'] } },
  { id: 'meta/plain', name: 'Meta: Plain', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['max_tokens'] },
];

test('answer model list keeps real-time text models with prices', () => {
  const list = toAnswerModels(raw);
  assert.deepEqual(list.map((m) => m.id), ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'meta/plain']);
  const sonnet = list.find((m) => m.id === 'anthropic/claude-sonnet-5.5');
  assert.equal(sonnet.input, 2);
  assert.equal(sonnet.output, 10);
  assert.equal(list.find((m) => m.id === 'meta/plain').reasoning, null);
});

test('reasoning choices respect mandatory reasoning', () => {
  const [haiku, sonnet, plain] = toAnswerModels(raw);
  assert.ok(!reasoningChoices(sonnet).includes('none'));
  assert.equal(reasoningChoices(haiku)[0], 'none');
  assert.deepEqual(reasoningChoices(plain), []);
});

test('reasoning param falls back to a valid effort', () => {
  const [haiku, sonnet, plain] = toAnswerModels(raw);
  assert.deepEqual(reasoningParam(sonnet, 'none'), { effort: 'low', exclude: true });
  assert.deepEqual(reasoningParam(sonnet, 'high'), { effort: 'high', exclude: true });
  assert.deepEqual(reasoningParam(haiku, 'none'), { effort: 'none' });
  assert.equal(reasoningParam(plain, 'low'), undefined);
});

test('model ids and speech-to-text list', () => {
  assert.ok(isModelId('openai/whisper-large-v3-turbo'));
  assert.ok(isModelId('openai/gpt-5:free'));
  assert.ok(!isModelId('../etc/passwd'));
  assert.ok(!isModelId('no-slash'));
  assert.deepEqual(toSttModels([{ id: 'b/x', name: 'B' }, { id: 'a/y', name: 'A' }]).map((m) => m.id), ['a/y', 'b/x']);
});
