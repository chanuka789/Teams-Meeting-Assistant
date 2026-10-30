// OpenRouter model list helpers. Pure, shared by the server and the browser, unit tested.

const MODEL_ID = /^[\w.-]+\/[\w.:~-]+$/;

export function isModelId(id) {
  return typeof id === 'string' && id.length <= 200 && MODEL_ID.test(id);
}

const perMillion = (p) => (p == null || p === '' ? null : Math.round(Number(p) * 1e6 * 1000) / 1000);

// Chat models that can write text answers. Batch variants are not real-time, so they are left out.
export function toAnswerModels(raw) {
  return raw
    .filter((m) => (m.architecture?.output_modalities || ['text']).includes('text'))
    .filter((m) => !m.id.endsWith(':batch'))
    .map((m) => {
      const supportsReasoning = (m.supported_parameters || []).includes('reasoning');
      return {
        id: m.id,
        name: m.name || m.id,
        input: perMillion(m.pricing?.prompt),   // USD per 1M input tokens
        output: perMillion(m.pricing?.completion),
        reasoning: supportsReasoning
          ? {
              mandatory: Boolean(m.reasoning?.mandatory),
              efforts: m.reasoning?.supported_efforts || ['high', 'medium', 'low'],
              default: m.reasoning?.default_effort || null,
            }
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Speech-to-text prices come in two units: Whisper-class models charge per second of audio
// (only `prompt` set), newer models charge per token (`completion` also set). A large per-unit
// prompt price with no completion price has an unclear unit, so no price is shown for it.
export function sttPrice(pricing = {}) {
  const p = Number(pricing.prompt) || 0;
  const c = Number(pricing.completion) || 0;
  if (c > 0) return { input: perMillion(p), output: perMillion(c) };
  if (p > 0 && p < 0.01) return { perHour: Math.round(p * 3600 * 1000) / 1000 };
  return null;
}

export function toSttModels(raw) {
  return raw
    .map((m) => ({ id: m.id, name: m.name || m.id, price: sttPrice(m.pricing) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The answer stream ends with COST_MARK + {"cost": <USD or null>, "sources": [{name, scope}]}.
export const COST_MARK = '\u001e';

export function splitCost(raw) {
  const i = raw.indexOf(COST_MARK);
  if (i === -1) return { text: raw, cost: null, sources: [] };
  let meta = {};
  try { meta = JSON.parse(raw.slice(i + 1)); } catch { /* trailer still arriving */ }
  return {
    text: raw.slice(0, i),
    cost: typeof meta.cost === 'number' ? meta.cost : null,
    sources: Array.isArray(meta.sources) ? meta.sources : [],
    meta,
  };
}

export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  if (n === 0) return '$0';
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  const s = n.toFixed(6).replace(/0+$/, '');
  return s === '0.' ? '<$0.000001' : '$' + s;
}

// Reasoning options that are valid for a model. `none` is only offered when reasoning can be turned off.
export function reasoningChoices(model) {
  if (!model?.reasoning) return [];
  const efforts = model.reasoning.efforts.filter((e) => e !== 'none');
  return model.reasoning.mandatory ? efforts : ['none', ...efforts];
}

// The `reasoning` request field for this model and wanted effort, or undefined to send nothing.
export function reasoningParam(model, wanted) {
  const choices = reasoningChoices(model);
  if (!choices.length) return undefined;
  let effort = choices.includes(wanted) ? wanted : choices.includes('low') ? 'low' : choices[choices.length - 1];
  if (effort === 'none') return { effort: 'none' };
  return { effort, exclude: true };
}
