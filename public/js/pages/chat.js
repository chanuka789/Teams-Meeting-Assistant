// Study chat: conversations with the AI that answers from the competency library and the user's case study,
// cites its sources, and opens cited passages in a side viewer (scrolled to and briefly highlighted).

import { reasoningChoices, splitCost } from '../../models.js';
import { h, icon, button, toast, openModal, confirmDialog, field, combobox, sizeStepper, fileTypeBadge } from '../ui.js';
import { api } from '../api.js';
import { pref, setPrefs, loadModels, session } from '../state.js';
import { parseMarkdown, citedNumbers } from '../markdown.js';
import { chatItems, fillThinkingSelect } from '../model-items.js';

const STARTERS = [
  { icon: 'book-open', title: 'Quiz me on a competency', text: 'One question at a time, with feedback', prompt: 'Quiz me on Contract practice at Level 3. Ask one question at a time and give feedback with a model answer after each of my replies.' },
  { icon: 'briefcase', title: 'Summarise my case study', text: 'Key issues, my role, options and outcome', prompt: 'Summarise my case study: the key issues, my role, the options I considered, my reasoned advice and the outcome, with the main figures.' },
  { icon: 'layers', title: 'Explain a RICS standard', text: 'NRM 1 vs NRM 2 with a table', prompt: 'Explain the difference between NRM 1 and NRM 2 with a comparison table, and how I use each one as a Quantity Surveyor.' },
  { icon: 'shield-check', title: 'Practise an ethics scenario', text: 'A realistic conflict of interest case', prompt: 'Give me a realistic APC ethics scenario about a conflict of interest, then walk me through the right answer under the RICS Rules of Conduct.' },
];
const LENGTHS = [['concise', 'Length: Concise'], ['standard', 'Length: Standard'], ['detailed', 'Length: Detailed']];

function dayGroup(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

export async function renderChat(page, params) {
  const st = {
    chats: [], chatId: Number(params[0]) || null, title: 'New chat', messages: [],
    streaming: null, models: null, docCache: new Map(), viewer: null,
  };
  page.style.setProperty('--chat-size', `${pref('chatSize') || 15}px`);

  // ---------- conversation list ----------
  const listBody = h('div', { class: 'chat-list-body', role: 'list' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search chats…', 'aria-label': 'Search chats' });
  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); });
  const list = h('aside', { class: 'chat-list', 'aria-label': 'Chats' },
    h('div', { class: 'chat-list-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Chats'),
        button('', { icon: 'panel-left', variant: 'ghost', size: 'sm', ariaLabel: 'Hide chat list', onClick: () => setListOpen(false) })),
      button('New chat', { icon: 'plus', variant: 'primary', onClick: () => newChat() }),
      h('div', { class: 'input-icon' }, icon('search'), search)),
    listBody);

  // ---------- conversation ----------
  const titleEl = h('h1', {}, 'New chat');
  const sizer = sizeStepper(pref('chatSize') || 15, { min: 12, max: 24, label: 'chat', onChange: (v) => { setPrefs({ chatSize: v }); page.style.setProperty('--chat-size', `${v}px`); } });
  sizer.classList.add('hide-narrow');
  const exportBtn = button('', { icon: 'download', variant: 'ghost', size: 'sm', ariaLabel: 'Export chat as a Markdown file', onClick: exportChat });
  const head = h('header', { class: 'chat-head' },
    button('', { icon: 'panel-left', variant: 'ghost', size: 'sm', ariaLabel: 'Show or hide chat list', onClick: () => setListOpen(layout.classList.contains('list-closed')) }),
    titleEl, sizer, exportBtn,
    button('', { icon: 'plus', variant: 'ghost', size: 'sm', ariaLabel: 'New chat', onClick: () => newChat() }));

  const inner = h('div', { class: 'thread-inner', 'aria-live': 'polite' });
  const jump = button('Jump to latest', { icon: 'arrow-down', size: 'sm', onClick: () => scrollBottom(true) });
  jump.classList.add('jump-chat');
  const thread = h('div', { class: 'chat-thread' }, inner, jump);
  thread.addEventListener('scroll', () => jump.classList.toggle('show', !nearBottom() && Boolean(st.messages.length)));

  // composer
  const input = h('textarea', { rows: '1', placeholder: 'Ask about your competencies, RICS standards or your case study…', 'aria-label': 'Message' });
  const sendBtn = button('', { icon: 'arrow-up', variant: 'primary', ariaLabel: 'Send message', type: 'submit' });
  sendBtn.classList.add('send-btn');
  const stopBtn = button('', { icon: 'square', variant: 'danger', ariaLabel: 'Stop generating', onClick: stop });
  stopBtn.classList.add('send-btn');
  stopBtn.hidden = true;
  const modelSlot = h('span', { class: 'skeleton', style: { width: '140px', height: '30px' } });
  const thinking = h('select', { class: 'select select-sm', 'aria-label': 'Thinking level', title: 'Thinking level: higher is more careful but slower',
    onchange: () => setPrefs({ chatReasoning: thinking.value }) });
  const scope = h('select', { class: 'select select-sm', 'aria-label': 'Search in', title: 'Which documents the AI searches',
    onchange: () => setPrefs({ chatScope: scope.value }) },
  h('option', { value: 'all' }, 'Search: All documents'), h('option', { value: 'library' }, 'Search: Competency library'), h('option', { value: 'case_study' }, 'Search: My case study'));
  const length = h('select', { class: 'select select-sm', 'aria-label': 'Answer length', onchange: () => setPrefs({ chatLength: length.value }) },
    LENGTHS.map(([v, l]) => h('option', { value: v, selected: v === (pref('chatLength') || 'standard') }, l)));
  const composer = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); send(); } },
    input,
    h('div', { class: 'composer-tools' }, modelSlot, thinking, scope, length, h('span', { class: 'spacer' }), stopBtn, sendBtn));
  const composerWrap = h('div', { class: 'composer-wrap' }, composer,
    h('p', { class: 'composer-hint' }, 'Answers use your documents and cite them. AI can make mistakes: check important facts.',
      h('span', { class: 'kbd-hint' }, ' ', h('span', { class: 'kbd' }, 'Enter'), ' to send, ', h('span', { class: 'kbd' }, 'Shift'), '+', h('span', { class: 'kbd' }, 'Enter'), ' for a new line.')));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  const main = h('section', { class: 'chat-main', 'aria-label': 'Conversation' }, head, thread, composerWrap);
  const viewer = h('aside', { class: 'viewer', 'aria-label': 'Document viewer', hidden: true });
  const layout = h('div', { class: 'chat-layout' }, list, h('div', { class: 'chat-scrim', onclick: () => setListOpen(false) }), main, viewer);
  page.replaceChildren(h('h1', { class: 'sr-only' }, 'Chat'), layout);

  const narrow = () => layout.clientWidth <= 1000;
  function setListOpen(open) {
    layout.classList.toggle('list-closed', !open);
    if (!narrow()) setPrefs({ chatListOpen: open });
  }
  layout.classList.toggle('list-closed', narrow() || pref('chatListOpen') === false);

  page.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (viewer.querySelector('.places-pop')) viewer.querySelector('.places-pop').remove();
    else if (!viewer.hidden) closeViewer();
    else if (narrow() && !layout.classList.contains('list-closed')) setListOpen(false);
  });

  // ---------- helpers ----------
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; }
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  function scrollBottom(force) { if (force || nearBottom()) thread.scrollTop = thread.scrollHeight; }
  function setStreaming(on) {
    stopBtn.hidden = !on;
    sendBtn.hidden = on;
  }

  // ---------- models, thinking, scope ----------
  (async () => {
    try {
      st.models = await loadModels();
      const d = st.models.defaults;
      // Chat has its own model and thinking level, separate from the Live interview answers
      const current = () => pref('chatModel') || d.answerModel;
      const drawThinking = () => fillThinkingSelect(thinking, st.models.answer.find((m) => m.id === current()), pref('chatReasoning') || d.reasoning, reasoningChoices);
      const picker = combobox({
        items: chatItems(st.models.answer, d.answerModel), value: current(), compact: true, ariaLabel: 'Chat model',
        placeholder: 'Search models, e.g. sonnet, opus, gpt…',
        onChange: (v) => { setPrefs({ chatModel: v, chatReasoning: '' }); drawThinking(); },
      });
      modelSlot.replaceWith(picker);
      drawThinking();
    } catch {
      modelSlot.replaceWith(h('span', { class: 'subtle small' }, 'Models unavailable'));
      thinking.hidden = true;
    }
  })();
  api('GET', '/api/competencies').then((comps) => {
    scope.append(h('optgroup', { label: 'One competency' }, comps.map((c) => h('option', { value: `competency:${c.id}` }, `Search: ${c.name}`))));
    scope.value = pref('chatScope') || 'all';
    if (!scope.value) scope.value = 'all';
  }).catch(() => { scope.value = pref('chatScope') || 'all'; });
  scope.value = pref('chatScope') || 'all';

  // ---------- list ----------
  async function loadList() {
    try {
      st.chats = await api('GET', `/api/chats${search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : ''}`);
    } catch (e) { toast(e.message, 'error'); return; }
    renderList();
  }
  function renderList() {
    if (!st.chats.length) {
      listBody.replaceChildren(h('div', { class: 'chat-list-empty' }, search.value.trim() ? 'No chats match your search.' : 'Your chats will appear here.'));
      return;
    }
    const nodes = [];
    let group = null;
    for (const c of st.chats) {
      const g = dayGroup(c.updatedAt);
      if (g !== group) { group = g; nodes.push(h('div', { class: 'chat-group' }, g)); }
      nodes.push(h('div', { class: 'chat-item', role: 'listitem', 'aria-current': String(c.id === st.chatId) },
        h('a', { href: `#/chat/${c.id}`, onclick: (e) => { e.preventDefault(); openChat(c.id); } }, h('span', { title: c.title }, c.title)),
        h('div', { class: 'item-actions' },
          button('', { icon: 'pencil', variant: 'ghost', size: 'sm', ariaLabel: `Rename ${c.title}`, onClick: () => renameChat(c) }),
          button('', { icon: 'trash-2', variant: 'ghost', size: 'sm', ariaLabel: `Delete ${c.title}`, onClick: () => deleteChat(c) }))));
    }
    listBody.replaceChildren(...nodes);
  }
  function renameChat(c) {
    const inputEl = h('input', { class: 'input', value: c.title, maxlength: '120' });
    openModal({
      title: 'Rename chat', body: [field('Title', inputEl)],
      actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'primary', submit: true, onClick: async () => {
        try {
          await api('PATCH', `/api/chats/${c.id}`, { title: inputEl.value });
          c.title = inputEl.value.trim();
          if (c.id === st.chatId) setTitle(c.title);
          renderList();
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
    inputEl.select();
  }
  async function deleteChat(c) {
    if (!(await confirmDialog({ title: 'Delete chat?', message: `“${c.title}” and all its messages will be deleted.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api('DELETE', `/api/chats/${c.id}`);
      st.chats = st.chats.filter((x) => x.id !== c.id);
      if (c.id === st.chatId) newChat(); else renderList();
      toast('Chat deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  function setTitle(t) {
    st.title = t;
    titleEl.textContent = t;
    document.title = `${t} · Chat · APC Assistant`;
  }

  // ---------- open / new ----------
  function newChat() {
    stop();
    st.chatId = null;
    st.messages = [];
    setTitle('New chat');
    history.replaceState(null, '', '#/chat');
    closeViewer();
    renderThread();
    renderList();
    if (narrow()) setListOpen(false);
    input.focus();
  }

  async function openChat(id) {
    stop();
    closeViewer();
    try {
      const data = await api('GET', `/api/chats/${id}`);
      st.chatId = data.id;
      st.messages = data.messages;
      setTitle(data.title);
      history.replaceState(null, '', `#/chat/${id}`);
      renderThread();
      renderList();
      scrollBottom(true);
      if (narrow()) setListOpen(false);
    } catch (e) {
      toast(e.message, 'error');
      newChat();
    }
  }

  // ---------- thread rendering ----------
  function renderThread() {
    if (!st.messages.length) {
      inner.replaceChildren(welcome());
      return;
    }
    inner.replaceChildren(...st.messages.map((m, i) => (m.role === 'user'
      ? h('div', { class: 'msg-user' }, m.content)
      : assistantEl(m, i === st.messages.length - 1))));
  }

  function welcome() {
    return h('div', { class: 'chat-welcome' },
      h('div', { class: 'logo' }, icon('sparkles')),
      h('h2', {}, `How can I help you prepare${session.me?.name ? `, ${session.me.name.split(' ')[0]}` : ''}?`),
      h('p', {}, 'Ask anything about your competencies, RICS standards or your case study. Answers come from your documents, with references you can open.'),
      h('div', { class: 'starters' }, STARTERS.map((s) => h('button', { type: 'button', class: 'starter', onclick: () => { input.value = s.prompt; autosize(); send(); } },
        icon(s.icon), h('div', {}, h('b', {}, s.title), h('span', {}, s.text))))));
  }

  // Sources actually cited in the text, grouped by document in order of first citation
  function citedGroups(m) {
    const byN = new Map((m.sources || []).map((s) => [s.n, s]));
    const groups = new Map();
    for (const n of citedNumbers(m.content)) {
      const s = byN.get(n);
      if (!s) continue;
      if (!groups.has(s.documentId)) groups.set(s.documentId, { ...s, passages: [] });
      groups.get(s.documentId).passages.push({ n, chunkId: s.chunkId });
    }
    return [...groups.values()];
  }

  function inlineNodes(parts, m, groups) {
    const byN = new Map((m.sources || []).map((s) => [s.n, s]));
    return parts.map((p) => {
      if (p.t === 'b') return h('strong', {}, p.v);
      if (p.t === 'i') return h('em', {}, p.v);
      if (p.t === 'code') return h('code', {}, p.v);
      if (p.t === 'cite') {
        const s = byN.get(p.v);
        if (!s) return h('button', { type: 'button', class: 'cite', disabled: true, title: 'Source not available' }, String(p.v));
        const g = groups.find((x) => x.documentId === s.documentId);
        return h('button', {
          type: 'button', class: `cite ${s.scope === 'case_study' ? 'case' : ''}`, title: `${s.doc}${s.competency ? ` · ${s.competency}` : ''}`,
          'aria-label': `Source ${p.v}: ${s.doc}`,
          onclick: () => openViewer(g, g.passages.findIndex((x) => x.n === p.v)),
        }, String(p.v));
      }
      return p.v;
    });
  }

  function markdownNodes(m) {
    const groups = citedGroups(m);
    const inl = (parts) => inlineNodes(parts, m, groups);
    return parseMarkdown(m.content).map((b) => {
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
  }

  function assistantEl(m, isLast) {
    const body = h('div', { class: 'msg-body' });
    const el = h('article', { class: 'msg-ai' }, h('div', { class: 'ai-avatar', 'aria-hidden': 'true' }, icon('sparkles')), body);
    el.update = (msg, done) => {
      const nodes = [];
      if (msg.error) {
        nodes.push(h('div', { class: 'callout warn msg-error' }, icon('triangle-alert'), h('div', { class: 'spacer' }, msg.error),
          button('Try again', { icon: 'refresh-cw', size: 'sm', onClick: () => regenerate() })));
      } else if (!msg.content) {
        nodes.push(h('div', { class: 'typing', 'aria-label': 'Writing answer' }, h('i'), h('i'), h('i')));
      } else {
        nodes.push(h('div', { class: 'md' }, markdownNodes(msg)));
      }
      if (done && msg.content) {
        const groups = citedGroups(msg);
        if (groups.length) {
          nodes.push(h('div', { class: 'msg-sources' }, h('span', { class: 'label' }, 'Sources'),
            groups.map((g) => h('button', {
              type: 'button', class: `src-chip ${g.scope === 'case_study' ? 'case' : ''}`,
              title: `${g.doc}${g.competency ? ` · ${g.competency}` : ''}${g.scope === 'case_study' ? ' · My case study' : ''}`,
              onclick: () => openViewer(g, 0, g.passages.length > 1),
            }, h('span', { class: 'dot' }, icon(g.scope === 'case_study' ? 'folder-lock' : 'library')), h('span', { class: 'name' }, g.doc),
            g.passages.length > 1 && h('span', { class: 'count' }, `${g.passages.length} places`)))));
        } else if ((msg.sources || []).length) {
          nodes.push(h('p', { class: 'msg-note' }, 'Answered from general knowledge: no document passages were cited.'));
        }
        if (msg.stopped) nodes.push(h('p', { class: 'msg-note' }, 'Stopped.'));
        nodes.push(h('div', { class: 'msg-actions' },
          button('', { icon: 'copy', variant: 'ghost', size: 'sm', ariaLabel: 'Copy answer', onClick: async () => {
            try { await navigator.clipboard.writeText(msg.content); toast('Answer copied'); } catch { toast('Copy failed', 'error'); }
          } }),
          isLast && button('', { icon: 'refresh-cw', variant: 'ghost', size: 'sm', ariaLabel: 'Regenerate answer', onClick: () => regenerate() }),
          msg.model && h('span', { class: 'model' }, shortModel(msg.model))));
      }
      body.replaceChildren(...nodes);
    };
    el.update(m, true);
    return el;
  }
  const shortModel = (id) => st.models?.answer.find((x) => x.id === id)?.name.split(':').pop().trim() || id.split('/').pop();

  // ---------- sending ----------
  async function send() {
    const text = input.value.trim();
    if (!text || st.streaming) return;
    input.value = '';
    autosize();
    if (!st.chatId) {
      try {
        const c = await api('POST', '/api/chats');
        st.chatId = c.id;
        history.replaceState(null, '', `#/chat/${c.id}`);
      } catch (e) { toast(e.message, 'error'); input.value = text; return; }
    }
    if (!st.messages.length) inner.replaceChildren();
    st.messages.push({ role: 'user', content: text });
    inner.append(h('div', { class: 'msg-user' }, text));
    await runAnswer({ content: text });
  }

  async function regenerate() {
    if (st.streaming || !st.chatId) return;
    const last = st.messages[st.messages.length - 1];
    if (last?.role === 'assistant') { st.messages.pop(); inner.lastChild?.remove(); }
    await runAnswer({ regenerate: true });
  }

  function stop() { st.streaming?.controller.abort(); }

  async function runAnswer(payload) {
    inner.querySelectorAll('.msg-ai').forEach((x) => x.querySelector('[aria-label="Regenerate answer"]')?.remove());
    const msg = { role: 'assistant', content: '', sources: [], model: pref('chatModel') || st.models?.defaults.answerModel };
    const el = assistantEl(msg, true);
    el.update(msg, false);
    inner.append(el);
    scrollBottom(true);
    const controller = new AbortController();
    st.streaming = { controller };
    setStreaming(true);
    const chatId = st.chatId;
    let raw = '';
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: controller.signal,
        body: JSON.stringify({
          ...payload, model: pref('chatModel') || undefined,
          reasoning: thinking.disabled ? undefined : thinking.value || undefined, scope: scope.value || 'all', length: length.value,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        msg.content = splitCost(raw).text;
        el.update(msg, false);
        scrollBottom(false);
      }
      const { text, sources, meta } = splitCost(raw);
      Object.assign(msg, { content: text, sources, id: meta.messageId });
      if (meta.title && chatId === st.chatId) setTitle(meta.title);
      if (!text.trim()) msg.error = 'The AI returned no answer. Please try again.';
    } catch (err) {
      if (err.name === 'AbortError') {
        msg.stopped = true;
        msg.content = splitCost(raw).text;
        if (!msg.content.trim()) { el.remove(); st.streaming = null; setStreaming(false); return; }
      } else {
        msg.error = err.message;
      }
    } finally {
      st.streaming = null;
      setStreaming(false);
    }
    if (chatId !== st.chatId) return; // the user switched chats meanwhile
    st.messages.push(msg);
    el.update(msg, true);
    scrollBottom(false);
    loadList();
  }

  // ---------- export ----------
  function exportChat() {
    if (!st.messages.length) { toast('This chat is empty.', 'info'); return; }
    const lines = [`# ${st.title}`, ''];
    for (const m of st.messages) {
      lines.push(m.role === 'user' ? `**You:** ${m.content}` : `**Assistant:**\n\n${m.content}`);
      if (m.role === 'assistant') {
        const g = citedGroups(m);
        if (g.length) lines.push('', `Sources: ${g.map((x) => x.doc).join(', ')}`);
      }
      lines.push('', '---', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${st.title.replace(/[^\w -]+/g, '').trim() || 'chat'}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- document viewer ----------
  // group: { documentId, doc, scope, competency, passages: [{ n, chunkId }] }
  async function openViewer(group, index = 0, showList = false) {
    viewer.hidden = false;
    layout.classList.add('viewer-open');
    if (!narrow() && layout.clientWidth < 1400) layout.classList.add('list-closed');
    st.viewer = { group, index: Math.max(0, index), ranges: [] };
    viewer.replaceChildren(viewerHead(group), h('div', { class: 'viewer-loading' },
      h('div', { class: 'skeleton', style: { height: '16px', width: '70%' } }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '85%' } })));
    const ids = group.passages.map((p) => p.chunkId);
    const key = `${group.documentId}:${ids.join(',')}`;
    let data = st.docCache.get(key);
    if (!data) {
      try {
        data = await api('GET', `/api/documents/${group.documentId}/view?chunks=${ids.join(',')}`);
        st.docCache.set(key, data);
      } catch (e) {
        viewer.replaceChildren(viewerHead(group), h('div', { class: 'viewer-loading' }, h('div', { class: 'callout warn' }, icon('triangle-alert'),
          h('div', {}, e.status === 404 ? 'This document was deleted or you no longer have access to it.' : e.message))));
        return;
      }
    }
    if (st.viewer?.group !== group) return; // another reference was opened meanwhile
    st.viewer.ranges = group.passages.map((p) => data.ranges.find((r) => Number(r.id) === Number(p.chunkId)) || null);
    st.viewer.text = data.text;
    const body = h('div', { class: 'viewer-body', tabindex: '0', 'aria-label': `${group.doc} text` }, docTextEl(data.text, st.viewer.ranges));
    viewer.replaceChildren(viewerHead(group, data), body);
    goToPassage(st.viewer.index);
    if (showList) togglePlaces(true);
    viewer.querySelector('.viewer-head button')?.focus({ preventScroll: true });
  }

  function viewerHead(group, data) {
    const v = st.viewer;
    const n = group.passages.length;
    const pos = h('span', { class: 'pos', 'aria-live': 'polite' }, n > 1 ? `Place ${v.index + 1} of ${n}` : 'Cited passage');
    const prev = button('', { icon: 'chevron-left', variant: 'ghost', size: 'sm', ariaLabel: 'Previous place', onClick: () => goToPassage(v.index - 1) });
    const next = button('', { icon: 'chevron-right', variant: 'ghost', size: 'sm', ariaLabel: 'Next place', onClick: () => goToPassage(v.index + 1) });
    prev.disabled = n < 2; next.disabled = n < 2;
    const headEl = h('div', { class: 'viewer-head' },
      h('div', { class: 'viewer-title' },
        Object.assign(button('', { icon: 'chevron-left', variant: 'ghost', size: 'sm', ariaLabel: 'Back to chat', onClick: closeViewer }), { className: 'btn btn-ghost btn-sm btn-icon back' }),
        fileTypeBadge(group.doc),
        h('div', { class: 't' }, h('b', { title: group.doc }, group.doc),
          h('span', {}, group.scope === 'case_study'
            ? h('span', { class: 'badge badge-case' }, icon('folder-lock'), 'My case study')
            : h('span', { class: 'badge' }, icon('library'), (data?.competency || group.competency || 'Library')))),
        button('', { icon: 'x', variant: 'ghost', size: 'sm', ariaLabel: 'Close document', onClick: closeViewer })),
      h('div', { class: 'viewer-nav' },
        prev, pos, next,
        n > 1 && button(`${n} places`, { icon: 'list', variant: 'ghost', size: 'sm', onClick: () => togglePlaces() }),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn btn-ghost btn-sm', href: `/api/documents/${group.documentId}/file`, target: '_blank', rel: 'noopener' }, icon('external-link'), 'Open original')));
    headEl.pos = pos;
    return headEl;
  }

  // Document text with each cited range wrapped in <mark data-p="0,2"> (ranges may overlap)
  function docTextEl(text, ranges) {
    const valid = ranges.map((r, i) => (r ? { ...r, i } : null)).filter(Boolean);
    const cuts = [...new Set([0, text.length, ...valid.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
    const out = h('div', { class: 'doc-text' });
    for (let k = 0; k < cuts.length - 1; k++) {
      const [a, b] = [cuts[k], cuts[k + 1]];
      const covering = valid.filter((r) => r.start <= a && r.end >= b).map((r) => r.i);
      const piece = text.slice(a, b);
      out.append(covering.length ? h('mark', { 'data-p': covering.join(',') }, piece) : piece);
    }
    return out;
  }

  function goToPassage(i) {
    const v = st.viewer;
    if (!v) return;
    const n = v.group.passages.length;
    v.index = (i + n) % n;
    const headEl = viewer.querySelector('.viewer-head');
    if (headEl?.pos) headEl.pos.textContent = n > 1 ? `Place ${v.index + 1} of ${n}` : 'Cited passage';
    viewer.querySelectorAll('.place').forEach((p, k) => p.setAttribute('aria-current', String(k === v.index)));
    const body = viewer.querySelector('.viewer-body');
    if (!body) return;
    const marks = [...body.querySelectorAll('mark')].filter((m) => m.dataset.p.split(',').includes(String(v.index)));
    if (!marks.length) {
      toast('This passage could not be located in the document text.', 'info');
      return;
    }
    // Restart the temporary highlight on every piece of this passage
    body.querySelectorAll('mark.flash').forEach((m) => m.classList.remove('flash'));
    void body.offsetWidth;
    marks.forEach((m) => m.classList.add('flash'));
    const top = marks[0].getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    body.scrollTo({ top: Math.max(0, top - body.clientHeight * 0.25), behavior: 'smooth' });
  }

  function togglePlaces(force) {
    const existing = viewer.querySelector('.places-pop');
    if (existing && force !== true) { existing.remove(); return; }
    if (existing) return;
    const v = st.viewer;
    const snippet = (r) => (r ? `${v.text.slice(r.start, Math.min(r.end, r.start + 220)).replace(/\s+/g, ' ').trim()}…` : 'Position not found in the document text.');
    const pop = h('div', { class: 'places-pop', role: 'dialog', 'aria-label': 'Places used in this document' },
      h('h3', {}, h('span', {}, `${v.group.passages.length} places used in this document`),
        button('', { icon: 'x', variant: 'ghost', size: 'sm', ariaLabel: 'Close list', onClick: () => pop.remove() })),
      v.group.passages.map((p, k) => h('button', {
        type: 'button', class: 'place', 'aria-current': String(k === v.index),
        onclick: () => { goToPassage(k); pop.remove(); },
      }, h('span', { class: 'n' }, `[${p.n}]`), h('span', { class: 'snip' }, snippet(v.ranges[k])))));
    viewer.querySelector('.viewer-head').append(pop);
    pop.querySelector('.place[aria-current="true"]')?.focus();
  }

  function closeViewer() {
    viewer.hidden = true;
    viewer.replaceChildren();
    layout.classList.remove('viewer-open');
    st.viewer = null;
    if (!narrow() && pref('chatListOpen') !== false) layout.classList.remove('list-closed');
  }

  // ---------- start ----------
  document.addEventListener('keydown', function focusComposer(e) {
    if (!page.isConnected) { document.removeEventListener('keydown', focusComposer); return; }
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
  await loadList();
  if (st.chatId) await openChat(st.chatId); else { renderThread(); input.focus({ preventScroll: true }); }
}
