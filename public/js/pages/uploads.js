// Upload queue with per-file progress, shared by the library and case study pages

import { h, icon, toast, fileTypeBadge } from '../ui.js';
import { uploadFile } from '../api.js';

const MAX_BYTES = 50 * 1024 * 1024;

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
      if (file.size > MAX_BYTES) {
        state.textContent = 'Too large';
        toast(`${file.name} is larger than 50 MB.`, 'error');
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
