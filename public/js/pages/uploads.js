// Upload queue with per-file progress, and the audio file states (processing / ready / failed),
// shared by the library and case study pages

import { h, icon, button, toast, fileTypeBadge, openModal, fmtBytes, fmtDate } from '../ui.js';
import { api, uploadFile } from '../api.js';
import { formatUsd } from '../../models.js';
import { parseMarkdown } from '../markdown.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
export const AUDIO_EXT = ['mp3', 'm4a', 'mp4', 'aac', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'mpga', 'mpeg'];
export const ACCEPT = `.pdf,.docx,.pptx,.txt,.md,.csv,${AUDIO_EXT.map((e) => `.${e}`).join(',')},audio/*`;
export const ACCEPT_TEXT = 'PDF, Word (.docx), PowerPoint (.pptx), TXT, Markdown (max 50 MB), or audio: MP3, M4A, WAV and more (max 300 MB)';
const isAudioName = (name) => AUDIO_EXT.includes(String(name).toLowerCase().split('.').pop());
const fmtDuration = (s) => {
  const t = Math.round(s || 0);
  return t >= 3600 ? `${Math.floor(t / 3600)} h ${Math.round((t % 3600) / 60)} min` : `${Math.max(1, Math.round(t / 60))} min`;
};

export function uploadQueue() {
  const el = h('div', { class: 'uploads', 'aria-live': 'polite' });
  async function add(files, urlFor, onDone) {
    for (const file of files) {
      const bar = h('i');
      const state = h('span', { class: 'subtle xs', style: { minWidth: '72px', textAlign: 'right' } }, 'Waiting…');
      const row = h('div', { class: 'upload-row' }, fileTypeBadge(file.name),
        h('span', { style: { flex: '0 1 40%', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
        h('div', { class: 'progress' }, bar), state);
      el.append(row);
      const audio = isAudioName(file.name);
      if (file.size > (audio ? MAX_AUDIO_BYTES : MAX_BYTES)) {
        state.textContent = 'Too large';
        toast(`${file.name} is larger than ${audio ? '300' : '50'} MB.`, 'error');
        continue;
      }
      try {
        state.textContent = 'Uploading…';
        const out = await uploadFile(urlFor(file), file, (p) => {
          bar.style.width = `${Math.round(p * 90)}%`;
          if (p >= 1) state.textContent = 'Reading…';
        });
        bar.style.width = '100%';
        state.replaceChildren(icon('circle-check'));
        state.style.color = 'var(--success)';
        if (out.warning) toast(`${file.name}: ${out.warning}`, 'info');
        else if (out.processing) toast(`${file.name}: uploaded. It is being transcribed and organised into notes, which takes a few minutes.`, 'info');
        else toast(`Added ${file.name}`);
        setTimeout(() => row.remove(), 2500);
      } catch (e) {
        state.textContent = 'Failed';
        state.style.color = 'var(--danger)';
        toast(e.message, 'error');
      }
    }
    await onDone?.();
  }
  return { el, add };
}

// ---------- documents in a list: the line under the name, and the actions ----------

// The line under a document's name; audio files show their progress, or what went wrong
export function docMeta(d, prefix = '') {
  if (d.source === 'audio' && d.status === 'processing') {
    return h('span', { class: 'doc-status' }, icon('loader-circle', 'spin'), d.progress || 'Processing…');
  }
  if (d.source === 'audio' && d.status === 'failed') {
    return h('span', { class: 'doc-status failed' }, icon('triangle-alert'), `Could not process: ${d.error || 'unknown error'}`);
  }
  const parts = d.source === 'audio'
    ? [`Audio · ${fmtDuration(d.durationS)}`, `notes ${d.chars.toLocaleString()} characters`, d.cost != null ? `cost ${formatUsd(d.cost)}` : null]
    : [fmtBytes(d.size), d.chars ? `${d.chars.toLocaleString()} characters` : 'no text found'];
  return h('span', {}, [prefix, parts.filter(Boolean).join(' · '), ' · added ', fmtDate(d.createdAt), d.uploadedBy ? ` by ${d.uploadedBy}` : ''].join(''));
}

// Audio files: read the notes (ready) or try again (failed); everything: open the original file
export function docActions(d, { canChange, onChanged }) {
  const out = [];
  if (d.source === 'audio' && d.status === 'ready') {
    out.push(button('', { icon: 'file-text', variant: 'ghost', size: 'sm', ariaLabel: `Read the notes of ${d.name}`, onClick: () => showNotes(d) }));
  }
  if (d.source === 'audio' && d.status === 'failed' && canChange) {
    out.push(button('Retry', { icon: 'refresh-cw', variant: 'ghost', size: 'sm', onClick: async () => {
      try { await api('POST', `/api/documents/${d.id}/retry`); toast('Processing again'); await onChanged?.(); } catch (e) { toast(e.message, 'error'); }
    } }));
  }
  out.push(h('a', { class: 'btn btn-ghost btn-sm btn-icon', href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener',
    title: d.source === 'audio' ? 'Play the recording' : 'Open', 'aria-label': `${d.source === 'audio' ? 'Play' : 'Open'} ${d.name}` },
  icon(d.source === 'audio' ? 'play' : 'external-link')));
  return out;
}

// While audio files are being processed, refresh the list every few seconds
export function refreshWhileProcessing(docs, page, reload) {
  if (!docs.some((d) => d.source === 'audio' && d.status === 'processing')) return;
  setTimeout(() => { if (page.isConnected) reload().catch(() => {}); }, 4000);
}

// The organised notes of an audio file, in a reading view (with a download button)
async function showNotes(d) {
  let text;
  try {
    const r = await fetch(`/api/documents/${d.id}/notes`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not open the notes.');
    text = await r.text();
  } catch (e) { toast(e.message, 'error'); return; }
  const inl = (parts) => parts.map((p) => (p.t === 'b' ? h('strong', {}, p.v) : p.t === 'i' ? h('em', {}, p.v)
    : p.t === 'code' ? h('code', {}, p.v) : p.t === 'cite' ? `[${p.v}]` : p.v));
  const blocks = parseMarkdown(text).map((b) => {
    if (b.type === 'h') return h(b.level === 1 ? 'h2' : b.level === 2 ? 'h3' : 'h4', {}, inl(b.inline));
    if (b.type === 'p') return h('p', {}, inl(b.inline));
    if (b.type === 'ul' || b.type === 'ol') return h(b.type, {}, b.items.map((it) => h('li', {}, inl(it))));
    if (b.type === 'quote') return h('blockquote', {}, inl(b.inline));
    if (b.type === 'code') return h('pre', {}, h('code', {}, b.text));
    if (b.type === 'table') {
      return h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, inl(c))))),
        h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inl(c))))))));
    }
    return null;
  });
  openModal({
    title: d.name, description: 'Notes made from this recording. The assistant uses them, and the full transcript, when it answers.',
    body: [h('div', { class: 'md notes-view', tabindex: '0', role: 'region', 'aria-label': 'Notes' }, blocks)], width: 'min(820px, calc(100vw - 32px))',
    actions: [
      { label: 'Download', icon: 'download', onClick: () => { window.open(`/api/documents/${d.id}/notes?download=1`, '_blank'); return false; } },
      { label: 'Close', variant: 'primary' },
    ],
  });
}
