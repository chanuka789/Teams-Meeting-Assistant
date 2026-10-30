// Model picker items and thinking-level helpers, shared by Settings and the Live interview screen

export const REASONING_LABELS = {
  none: 'Off (fastest)', minimal: 'Minimal', low: 'Low (fast)', medium: 'Medium',
  high: 'High (slower)', xhigh: 'Extra high (slow)', max: 'Max (slowest)',
};
export const REASONING_SHORT = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

// The level to show as selected: the wanted one if the model supports it, else Low, else the lowest
export function reasoningSelection(choices, wanted) {
  return choices.includes(wanted) ? wanted : choices.includes('low') ? 'low' : choices[choices.length - 1];
}

export const RECOMMENDED = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5'];
export const providerOf = (m) => (m.name.includes(':') ? m.name.split(':')[0] : m.id.split('/')[0]);
export const shortName = (m) => (m.name.includes(':') ? m.name.split(':').slice(1).join(':').trim() : m.name);

// Chat models as combobox items: the default and recommended ones first, then by provider
export function chatItems(models, defaultId) {
  const tags = (m) => [
    m.id === defaultId && { text: 'Default', kind: 'accent' },
    m.input === 0 && m.output === 0 && { text: 'Free', kind: 'success' },
  ].filter(Boolean);
  const item = (m, group) => ({
    value: m.id, label: shortName(m), group,
    sub: m.input == null ? providerOf(m) : `${providerOf(m)} · $${m.input} in / $${m.output} out per 1M tokens`,
    tags: tags(m),
  });
  const top = [defaultId, ...RECOMMENDED].filter((id, i, a) => a.indexOf(id) === i)
    .map((id) => models.find((m) => m.id === id)).filter(Boolean);
  const rest = models.filter((m) => !top.includes(m))
    .sort((a, b) => providerOf(a).localeCompare(providerOf(b)) || a.name.localeCompare(b.name));
  return [...top.map((m) => item(m, 'Recommended')), ...rest.map((m) => item(m, providerOf(m)))];
}

export function sttItems(models, defaultId) {
  const price = (p) => (!p ? 'price: see OpenRouter' : p.perHour != null ? `$${p.perHour} per audio hour` : `$${p.input} in / $${p.output} out per 1M tokens`);
  const def = models.filter((m) => m.id === defaultId);
  return [...def, ...models.filter((m) => m.id !== defaultId)].map((m) => ({
    value: m.id, label: shortName(m), group: m.id === defaultId ? 'Default' : providerOf(m),
    sub: `${providerOf(m)} · ${price(m.price)}`, tags: m.id === defaultId ? [{ text: 'Default', kind: 'accent' }] : [],
  }));
}

// Fill a compact "Thinking: …" select for a model; returns false when the model has no thinking levels
export function fillThinkingSelect(select, model, wanted, reasoningChoices) {
  const choices = reasoningChoices(model);
  select.disabled = !choices.length;
  if (!choices.length) {
    select.replaceChildren(new Option('Thinking: n/a', ''));
    return false;
  }
  const sel = reasoningSelection(choices, wanted);
  select.replaceChildren(...choices.map((c) => {
    const o = new Option(`Thinking: ${REASONING_SHORT[c] || c}`, c, false, c === sel);
    o.title = REASONING_LABELS[c] || c;
    return o;
  }));
  return true;
}
