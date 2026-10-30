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

export function toSttModels(raw) {
  return raw
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
