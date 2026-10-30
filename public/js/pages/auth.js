// Sign-in page, and first-time setup of the admin account

import { h, icon, button, field, segmented } from '../ui.js';
import { api } from '../api.js';
import { applyTheme, storedTheme } from '../state.js';

export function renderAuth(root, { setup, onDone }) {
  const isSetup = setup.needsSetup;
  const error = h('div', { class: 'error-text', role: 'alert' });

  const inputs = {
    name: h('input', { class: 'input', autocomplete: 'name', required: true }),
    username: h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true }),
    password: h('input', { class: 'input', type: 'password', autocomplete: isSetup ? 'new-password' : 'current-password', required: true, minlength: isSetup ? '8' : undefined }),
    setupKey: h('input', { class: 'input', type: 'password', autocomplete: 'off', required: true }),
  };
  const submit = button(isSetup ? 'Create admin account' : 'Sign in', { variant: 'primary', size: 'lg', type: 'submit', icon: isSetup ? 'shield-check' : 'log-in' });
  submit.classList.add('btn-block');

  const showPw = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false', onclick: () => {
    const show = inputs.password.type === 'password';
    inputs.password.type = show ? 'text' : 'password';
    showPw.setAttribute('aria-pressed', String(show));
    showPw.lastChild.textContent = show ? 'Hide' : 'Show';
  } }, icon('eye'), 'Show');

  const form = h('form', { class: 'stack', style: { gap: '16px' }, novalidate: true },
    isSetup && field('Your name', inputs.name),
    field('Username', inputs.username, isSetup ? 'You will use this to sign in, e.g. your first name or email.' : undefined),
    h('div', { class: 'field' },
      h('div', { class: 'row' }, h('label', { for: 'pw', class: 'label' }, 'Password'), h('span', { class: 'spacer' }), showPw),
      Object.assign(inputs.password, { id: 'pw' }),
      isSetup && h('div', { class: 'hint' }, 'At least 8 characters.')),
    isSetup && setup.keyRequired && field('Setup key', inputs.setupKey, 'The APP_PASSWORD value from Railway. It proves you own this app.'),
    error,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      if (isSetup) {
        await api('POST', '/api/setup', {
          name: inputs.name.value, username: inputs.username.value, password: inputs.password.value, setupKey: inputs.setupKey.value,
        });
      } else {
        await api('POST', '/api/login', { username: inputs.username.value, password: inputs.password.value });
      }
      onDone();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  const theme = segmented(['light', 'system', 'dark'].map((v) => ({
    value: v, icon: { light: 'sun', system: 'monitor', dark: 'moon' }[v], label: h('span', { class: 'sr-only' }, `${v} theme`),
  })), storedTheme(), applyTheme, 'Colour theme');

  root.replaceChildren(h('div', { class: 'auth' },
    h('section', { class: 'auth-hero', 'aria-hidden': 'true' },
      h('div', { class: 'brand' },
        h('div', { class: 'logo' }, icon('audio-lines')),
        h('div', {}, h('div', { class: 'brand-name' }, 'APC Assistant'), h('div', { class: 'brand-sub' }, 'RICS interview companion'))),
      h('div', {},
        h('h2', {}, 'Calm, accurate answers in your APC final interview.'),
        h('p', { class: 'lead' }, 'Hears the assessors, spots each question and shows clear points from your competency library and your own case study.'),
        h('ul', { class: 'feature-list' },
          h('li', {}, icon('radio-tower'), h('div', {}, h('b', {}, 'Live question detection'), 'Only the assessors’ voices, in English, joined into full questions.')),
          h('li', {}, icon('library'), h('div', {}, h('b', {}, 'Your 19 competencies'), 'A shared library of RICS guidance, organised by competency.')),
          h('li', {}, icon('folder-lock'), h('div', {}, h('b', {}, 'Private case study'), 'Each candidate’s case study is visible only to them.')))),
      h('div', { class: 'auth-foot' }, 'AI suggestions can be wrong. Check facts and follow RICS rules on assessment conduct.')),
    h('section', { class: 'auth-panel' },
      h('div', { class: 'auth-theme' }, theme),
      h('div', { class: 'auth-card' },
        h('div', {},
          h('h1', {}, isSetup ? 'Set up your app' : 'Welcome back'),
          h('p', { class: 'lead' }, isSetup ? 'Create the first admin account. You can add other users afterwards.' : 'Sign in to continue to your interview assistant.')),
        h('div', { class: 'card card-pad' }, form)))));
  (isSetup ? inputs.name : inputs.username).focus();
}
