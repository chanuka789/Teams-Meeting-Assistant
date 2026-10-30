// My case study: each user's private documents, used when assessors ask about the case study

import { h, icon, button, toast, confirmDialog, emptyState, fileTypeBadge, dropzone, fmtBytes, fmtDate } from '../ui.js';
import { api } from '../api.js';
import { uploadQueue } from './uploads.js';
import { ACCEPT } from './library.js';

export async function renderCaseStudy(page) {
  const listCard = h('div', { class: 'card' });
  const queue = uploadQueue();

  page.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' },
        h('h1', {}, 'My case study'),
        h('p', {}, 'Your case study report, presentation slides and supporting notes. Assessors ask many questions about your case study, '
          + 'so the assistant uses these documents first for those questions.'))),
    h('div', { class: 'callout case' }, icon('folder-lock'),
      h('div', {}, h('b', {}, 'Private to you. '), 'Other users, including admins, cannot see or open your case study documents.')),
    dropzone({
      title: 'Upload case study documents',
      text: 'Drag files here or click to choose. PDF, Word (.docx), PowerPoint (.pptx), TXT, Markdown · max 50 MB each.',
      accept: ACCEPT,
      onFiles: (files) => queue.add(files, (f) => `/api/documents?scope=case_study&name=${encodeURIComponent(f.name)}`, load),
    }),
    queue.el,
    listCard,
    h('div', { class: 'card card-pad stack' },
      h('h2', { style: { fontSize: 'var(--t-base)' } }, 'What to upload'),
      h('ul', { class: 'steps', style: { maxWidth: 'none' } },
        h('li', {}, h('span', {}, h('b', {}, 'Case study report'), ' – the full submitted version (Word or PDF).')),
        h('li', {}, h('span', {}, h('b', {}, 'Presentation slides'), ' – your 10-minute presentation (.pptx). Speaker notes are read too.')),
        h('li', {}, h('span', {}, h('b', {}, 'Key figures'), ' – cost plans, valuations, variation logs or a one-page summary of numbers and dates.')),
        h('li', {}, h('span', {}, h('b', {}, 'Lessons and reflections'), ' – what went well, what you would do differently, and why.')))));

  async function load() {
    const docs = await api('GET', '/api/documents?scope=case_study');
    listCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', {}, 'Documents'), h('span', { class: 'badge' }, `${docs.length}`)),
      docs.length
        ? h('div', { class: 'doc-list' }, docs.map((d) => h('div', { class: 'doc' },
          fileTypeBadge(d.name),
          h('div', { class: 'meta' }, h('b', { title: d.name }, d.name),
            h('span', {}, `${fmtBytes(d.size)} · ${d.chars ? `${d.chars.toLocaleString()} characters` : 'no text found'} · added ${fmtDate(d.createdAt)}`)),
          h('div', { class: 'actions' },
            h('a', { class: 'btn btn-ghost btn-sm btn-icon', href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener', title: 'Open', 'aria-label': `Open ${d.name}` }, icon('external-link')),
            button('', { icon: 'trash-2', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${d.name}`, onClick: async () => {
              if (!(await confirmDialog({ title: 'Delete document?', message: `“${d.name}” will be permanently deleted.`, confirmLabel: 'Delete', danger: true }))) return;
              try { await api('DELETE', `/api/documents/${d.id}`); toast('Document deleted'); await load(); } catch (e) { toast(e.message, 'error'); }
            } })))))
        : emptyState({ icon: 'briefcase', title: 'No case study documents yet', text: 'Upload your case study so the assistant can answer questions about it in your own words and figures.' }));
  }

  await load();
}
