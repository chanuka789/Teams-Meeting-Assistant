// Users (admin): add people, reset passwords, change roles, see spend

import { formatUsd } from '../../models.js';
import { h, icon, button, toast, field, openModal, confirmDialog, initials, fmtDate } from '../ui.js';
import { api } from '../api.js';
import { session } from '../state.js';

export async function renderUsers(page) {
  const tableCard = h('div', { class: 'card' });
  page.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' }, h('h1', {}, 'Users'),
        h('p', {}, 'Everyone shares the competency library. Each user has their own private case study, notes and settings.')),
      button('Add user', { icon: 'user-plus', variant: 'primary', onClick: addUser })),
    tableCard);

  async function load() {
    const users = await api('GET', '/api/users');
    tableCard.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['User', 'Role', 'Case study', 'Spend this month', 'Last sign-in', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('div', { class: 'person' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(u.name)),
          h('div', {}, h('b', {}, u.name, u.id === session.me.id ? ' (you)' : ''), h('span', {}, u.username)))),
        h('td', {}, u.role === 'admin' ? h('span', { class: 'badge badge-accent' }, icon('shield-check'), 'Admin') : h('span', { class: 'badge' }, 'Member')),
        h('td', { class: 'num' }, `${u.caseStudyDocs} document${u.caseStudyDocs === 1 ? '' : 's'}`),
        h('td', { class: 'num' }, formatUsd(u.usage?.month.total ?? 0)),
        h('td', { class: 'muted' }, fmtDate(u.lastLoginAt)),
        h('td', {}, h('div', { class: 'actions' },
          button('', { icon: 'key-round', variant: 'ghost', size: 'sm', ariaLabel: `Reset password for ${u.name}`, onClick: () => resetPassword(u) }),
          u.id !== session.me.id && button('', { icon: 'shield-check', variant: 'ghost', size: 'sm',
            ariaLabel: u.role === 'admin' ? `Make ${u.name} a member` : `Make ${u.name} an admin`, onClick: () => toggleRole(u) }),
          u.id !== session.me.id && button('', { icon: 'trash-2', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${u.name}`, onClick: () => deleteUser(u) })))))))));
  }

  const pwField = () => h('input', { class: 'input', type: 'text', autocomplete: 'off', minlength: '8', value: suggestPassword() });

  function addUser() {
    const name = h('input', { class: 'input', required: true });
    const username = h('input', { class: 'input', autocapitalize: 'none', spellcheck: 'false', required: true });
    const password = pwField();
    const role = h('select', { class: 'select' }, h('option', { value: 'user' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));
    const { dlg } = openModal({
      title: 'Add user', description: 'Share the username and password with them. They can change the password in Settings.',
      body: [field('Name', name), h('div', { class: 'grid-2' }, field('Username', username, 'Letters, numbers, . _ @ -'), field('Role', role)),
        field('Temporary password', password, 'At least 8 characters.')],
      actions: [{ label: 'Cancel' }, { label: 'Add user', variant: 'primary', icon: 'user-plus', submit: true, onClick: async () => {
        try {
          await api('POST', '/api/users', { name: name.value, username: username.value, password: password.value, role: role.value });
          toast(`${name.value} added`);
          await load();
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
    dlg.querySelector('input').focus();
  }

  function resetPassword(u) {
    const password = pwField();
    openModal({
      title: `Reset password`, description: `${u.name} (${u.username}) will be signed out everywhere.`,
      body: [field('New password', password, 'At least 8 characters. Share it with them securely.')],
      actions: [{ label: 'Cancel' }, { label: 'Reset password', variant: 'primary', submit: true, onClick: async () => {
        try { await api('PATCH', `/api/users/${u.id}`, { password: password.value }); toast('Password reset'); } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }

  async function toggleRole(u) {
    const role = u.role === 'admin' ? 'user' : 'admin';
    if (!(await confirmDialog({ title: role === 'admin' ? 'Make admin?' : 'Remove admin rights?',
      message: role === 'admin' ? `${u.name} will be able to manage users and the competency library.` : `${u.name} will become a member.`,
      confirmLabel: role === 'admin' ? 'Make admin' : 'Make member' }))) return;
    try { await api('PATCH', `/api/users/${u.id}`, { role }); toast('Role updated'); await load(); } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteUser(u) {
    if (!(await confirmDialog({ title: 'Delete user?', message: `${u.name} and their private case study documents will be permanently deleted.`, confirmLabel: 'Delete user', danger: true }))) return;
    try { await api('DELETE', `/api/users/${u.id}`); toast('User deleted'); await load(); } catch (e) { toast(e.message, 'error'); }
  }

  await load();
}

function suggestPassword() {
  const words = 'cedar,river,amber,falcon,harbour,meadow,summit,copper,lantern,orbit'.split(',');
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  return `${pick()}-${pick()}-${crypto.getRandomValues(new Uint32Array(1))[0] % 900 + 100}`;
}
