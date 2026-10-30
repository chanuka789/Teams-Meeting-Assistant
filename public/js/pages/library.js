// Competency library: shared RICS documents organised by competency. Admins upload and organise.

import { h, icon, button, toast, field, openModal, confirmDialog, emptyState, fileTypeBadge, dropzone, fmtBytes, fmtDate } from '../ui.js';
import { api } from '../api.js';
import { session } from '../state.js';
import { uploadQueue } from './uploads.js';

const GROUPS = [
  { key: 'mandatory', label: 'Mandatory' },
  { key: 'core', label: 'Core' },
  { key: 'optional', label: 'Optional' },
  { key: 'general', label: 'General' },
];
export const ACCEPT = '.pdf,.docx,.pptx,.txt,.md,.csv';

export async function renderLibrary(page, params) {
  const isAdmin = session.me.role === 'admin';
  let comps = [];
  let docs = [];
  let selected = Number(params[0]) || null;
  let filter = '';

  const listEl = h('nav', { class: 'card comp-list', 'aria-label': 'Competencies' });
  const detail = h('div', { class: 'stack', style: { gap: '16px', minWidth: '0' } });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search all documents…', 'aria-label': 'Search documents',
    oninput: () => { filter = search.value.trim().toLowerCase(); renderDetail(); } });

  page.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' },
        h('h1', {}, 'Competency library'),
        h('p', {}, 'RICS guidance and notes for the Quantity surveying and construction pathway, shared with everyone. '
          + 'The assistant searches these documents when it answers technical questions.')),
      h('div', { class: 'input-icon', style: { width: '280px' } }, icon('search'), search),
      isAdmin && button('Edit competencies', { icon: 'pencil', onClick: editCompetencies })),
    h('div', { class: 'lib' }, listEl, detail));

  async function load() {
    [comps, docs] = await Promise.all([api('GET', '/api/competencies'), api('GET', '/api/documents?scope=library')]);
    if (!selected || !comps.some((c) => c.id === selected)) selected = comps[0]?.id ?? null;
    renderList();
    renderDetail();
  }

  function select(id) {
    selected = id;
    filter = '';
    search.value = '';
    history.replaceState(null, '', `#/library/${id}`);
    renderList();
    renderDetail();
  }

  function renderList() {
    listEl.replaceChildren(...GROUPS.map((g) => {
      const items = comps.filter((c) => c.category === g.key);
      if (!items.length) return null;
      return h('div', { class: 'comp-group' },
        h('h4', {}, h('span', {}, g.label), h('span', { class: 'num' }, items.length)),
        items.map((c) => h('button', {
          class: 'comp', type: 'button', 'aria-current': String(c.id === selected && !filter), onclick: () => select(c.id),
        }, h('span', { class: 'name' }, c.name), c.level && h('span', { class: 'lvl', title: `Level ${c.level}` }, `L${c.level}`),
        h('span', { class: 'cnt' }, c.docs || ''))));
    }));
  }

  function docRow(d) {
    const comp = comps.find((c) => c.id === d.competencyId);
    return h('div', { class: 'doc' },
      fileTypeBadge(d.name),
      h('div', { class: 'meta' },
        h('b', { title: d.name }, d.name),
        h('span', {}, [filter && comp ? `${comp.name} · ` : '', fmtBytes(d.size), ' · ',
          d.chars ? `${d.chars.toLocaleString()} characters` : 'no text found', ' · added ', fmtDate(d.createdAt),
          d.uploadedBy ? ` by ${d.uploadedBy}` : ''].join(''))),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-ghost btn-sm btn-icon', href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener', title: 'Open', 'aria-label': `Open ${d.name}` }, icon('external-link')),
        isAdmin && button('', { icon: 'folder-input', variant: 'ghost', size: 'sm', ariaLabel: `Move ${d.name}`, onClick: () => moveDoc(d) }),
        isAdmin && button('', { icon: 'trash-2', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${d.name}`, onClick: () => deleteDoc(d) })));
  }

  function renderDetail() {
    if (filter) {
      const hits = docs.filter((d) => d.name.toLowerCase().includes(filter));
      detail.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, `Search results`), h('span', { class: 'badge' }, `${hits.length}`)),
        hits.length ? h('div', { class: 'doc-list' }, hits.map(docRow))
          : emptyState({ icon: 'search', title: 'No documents match', text: `Nothing in the library is called “${search.value}”.` })));
      renderList();
      return;
    }
    const c = comps.find((x) => x.id === selected);
    if (!c) { detail.replaceChildren(emptyState({ icon: 'library', title: 'No competencies yet' })); return; }
    const mine = docs.filter((d) => d.competencyId === c.id);
    const queue = uploadQueue();
    detail.replaceChildren(
      h('div', { class: 'card card-pad stack', style: { gap: '6px' } },
        h('div', { class: 'row wrap' },
          h('span', { class: 'badge badge-accent' }, GROUPS.find((g) => g.key === c.category)?.label || c.category),
          c.level && h('span', { class: 'badge' }, `Level ${c.level}`)),
        h('h2', { style: { fontSize: 'var(--t-xl)' } }, c.name),
        h('p', { class: 'muted' }, `${mine.length} document${mine.length === 1 ? '' : 's'}`)),
      isAdmin && dropzone({
        title: 'Upload documents to this competency',
        text: 'Drag files here or click to choose. PDF, Word (.docx), PowerPoint (.pptx), TXT, Markdown · max 50 MB each.',
        accept: ACCEPT,
        onFiles: (files) => queue.add(files, (f) => `/api/documents?scope=library&competencyId=${c.id}&name=${encodeURIComponent(f.name)}`, load),
      }),
      queue.el,
      h('div', { class: 'card' },
        mine.length ? h('div', { class: 'doc-list' }, mine.map(docRow))
          : emptyState({ icon: 'file-text', title: 'No documents yet',
            text: isAdmin ? 'Upload RICS guidance, your notes or slides for this competency.' : 'An admin has not added documents to this competency yet.' })));
  }

  async function moveDoc(d) {
    const select = h('select', { class: 'select' }, GROUPS.map((g) => h('optgroup', { label: g.label },
      comps.filter((c) => c.category === g.key).map((c) => h('option', { value: c.id, selected: c.id === d.competencyId }, c.name)))));
    openModal({
      title: 'Move document', description: d.name,
      body: [field('Competency', select)],
      actions: [{ label: 'Cancel' }, { label: 'Move', variant: 'primary', submit: true, onClick: async () => {
        try { await api('PATCH', `/api/documents/${d.id}`, { competencyId: Number(select.value) }); toast('Document moved'); await load(); } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }

  async function deleteDoc(d) {
    if (!(await confirmDialog({ title: 'Delete document?', message: `“${d.name}” will be removed from the library for everyone.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/documents/${d.id}`); toast('Document deleted'); await load(); } catch (e) { toast(e.message, 'error'); }
  }

  function editCompetencies() {
    const list = h('div', { class: 'stack', style: { gap: '6px', maxHeight: '50vh', overflow: 'auto' } });
    const draw = () => list.replaceChildren(...comps.map((c) => h('div', { class: 'row' },
      h('input', { class: 'input', value: c.name, 'aria-label': 'Competency name', onchange: async (e) => {
        try { await api('PATCH', `/api/competencies/${c.id}`, { name: e.target.value }); c.name = e.target.value; renderList(); renderDetail(); } catch (err) { toast(err.message, 'error'); }
      } }),
      h('select', { class: 'select', style: { width: '120px' }, 'aria-label': 'Category', onchange: async (e) => {
        try { await api('PATCH', `/api/competencies/${c.id}`, { category: e.target.value }); c.category = e.target.value; renderList(); } catch (err) { toast(err.message, 'error'); }
      } }, GROUPS.map((g) => h('option', { value: g.key, selected: g.key === c.category }, g.label))),
      h('select', { class: 'select', style: { width: '84px' }, 'aria-label': 'Level', onchange: async (e) => {
        try { await api('PATCH', `/api/competencies/${c.id}`, { level: e.target.value || null }); c.level = Number(e.target.value) || null; renderList(); } catch (err) { toast(err.message, 'error'); }
      } }, ['', 1, 2, 3].map((l) => h('option', { value: l, selected: (c.level || '') === l }, l ? `L${l}` : '–'))),
      button('', { icon: 'trash-2', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${c.name}`, onClick: async () => {
        if (!(await confirmDialog({ title: 'Delete competency?', message: `“${c.name}” will be removed. It must have no documents.`, confirmLabel: 'Delete', danger: true }))) return;
        try { await api('DELETE', `/api/competencies/${c.id}`); comps = comps.filter((x) => x.id !== c.id); draw(); renderList(); renderDetail(); } catch (err) { toast(err.message, 'error'); }
      } }))));
    draw();
    const newName = h('input', { class: 'input', placeholder: 'New competency name' });
    const newCat = h('select', { class: 'select', style: { width: '140px' }, 'aria-label': 'Category' }, GROUPS.map((g) => h('option', { value: g.key, selected: g.key === 'optional' }, g.label)));
    openModal({
      title: 'Edit competencies', width: 'min(760px, calc(100vw - 32px))',
      description: 'Changes save as you go. Based on the RICS Quantity surveying and construction pathway guide (December 2025).',
      body: [list, h('hr', { class: 'divider' }), h('div', { class: 'row' }, newName, newCat,
        button('Add', { icon: 'plus', variant: 'primary', onClick: async () => {
          if (!newName.value.trim()) return;
          try { await api('POST', '/api/competencies', { name: newName.value, category: newCat.value }); newName.value = ''; await load(); draw(); toast('Competency added'); } catch (e) { toast(e.message, 'error'); }
        } }))],
      actions: [{ label: 'Done', variant: 'primary' }],
    });
  }

  await load();
}
