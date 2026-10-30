// Study chat: conversations saved per user; answers use the library and the user's case study with
// numbered citations, so the browser can open the cited passage in the document viewer.

import express from 'express';
import { q } from '../db.js';
import { requireUser } from '../auth.js';
import { buildChatMessages, CHAT_LENGTHS } from '../prompt.js';
import { reasoningParam, COST_MARK } from '../../public/models.js';
import { config, OPENROUTER, requireKey, orHeaders, pickModel, recordUsage } from '../openrouter.js';
import { searchForChat } from '../documents.js';

export const router = express.Router();
router.use(requireUser);

const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 16000;

const chatJson = (c) => ({ id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at });
const msgJson = (m) => ({ id: Number(m.id), role: m.role, content: m.content, sources: m.sources, model: m.model, createdAt: m.created_at });

async function ownChat(req, res) {
  const { rows } = await q('select * from chats where id = $1 and user_id = $2', [Number(req.params.id), req.user.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Chat not found.' }); return null; }
  return rows[0];
}

// ?q= searches titles and message text
router.get('/chats', async (req, res) => {
  const term = String(req.query.q || '').trim();
  const { rows } = term
    ? await q(`select c.* from chats c where c.user_id = $1 and (c.title ilike $2 or exists (
                 select 1 from chat_messages m where m.chat_id = c.id and m.content ilike $2))
               order by c.updated_at desc limit 200`, [req.user.id, `%${term.replace(/[%_\\]/g, '\\$&')}%`])
    : await q('select * from chats where user_id = $1 order by updated_at desc limit 200', [req.user.id]);
  res.json(rows.map(chatJson));
});

router.post('/chats', async (req, res) => {
  const { rows } = await q('insert into chats (user_id) values ($1) returning *', [req.user.id]);
  res.json(chatJson(rows[0]));
});

router.get('/chats/:id', async (req, res) => {
  const chat = await ownChat(req, res);
  if (!chat) return;
  const { rows } = await q('select * from chat_messages where chat_id = $1 order by id', [chat.id]);
  res.json({ ...chatJson(chat), messages: rows.map(msgJson) });
});

router.patch('/chats/:id', async (req, res) => {
  const chat = await ownChat(req, res);
  if (!chat) return;
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Enter a title.' });
  await q('update chats set title = $2 where id = $1', [chat.id, title]);
  res.json({ ok: true });
});

router.delete('/chats/:id', async (req, res) => {
  const chat = await ownChat(req, res);
  if (!chat) return;
  await q('delete from chats where id = $1', [chat.id]);
  res.json({ ok: true });
});

const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, '')}…`;
};

// Send a message (or { regenerate: true } to answer the last question again).
// Response: streamed answer text, then COST_MARK + { cost, sources, messageId, title }.
router.post('/chats/:id/messages', requireKey, async (req, res) => {
  const chat = await ownChat(req, res);
  if (!chat) return;
  const body = req.body || {};
  const p = req.user.prefs || {};

  let question;
  if (body.regenerate) {
    const { rows } = await q(`select id, content from chat_messages where chat_id = $1 and role = 'user' order by id desc limit 1`, [chat.id]);
    if (!rows[0]) return res.status(400).json({ error: 'Nothing to regenerate.' });
    question = rows[0].content;
    await q('delete from chat_messages where chat_id = $1 and id > $2', [chat.id, rows[0].id]);
  } else {
    question = String(body.content || '').trim().slice(0, 8000);
    if (!question) return res.status(400).json({ error: 'Type a message.' });
    await q(`insert into chat_messages (chat_id, role, content) values ($1, 'user', $2)`, [chat.id, question]);
  }
  let title = chat.title;
  if (title === 'New chat') {
    title = titleFrom(question);
    await q('update chats set title = $2 where id = $1', [chat.id, title]);
  }

  // Conversation so far (without the question just asked), newest kept within limits
  const { rows: past } = await q(
    'select role, content from chat_messages where chat_id = $1 order by id desc limit $2', [chat.id, HISTORY_MESSAGES + 1]);
  past.shift(); // the question itself
  const history = [];
  let chars = 0;
  for (const m of past) {
    if (chars + m.content.length > HISTORY_CHARS) break;
    history.unshift(m);
    chars += m.content.length;
  }

  // Search: short follow-ups ("and NRM 3?") also use the previous question's words
  const lastUser = history.filter((m) => m.role === 'user').pop();
  const searchText = question.length < 80 && lastUser ? `${lastUser.content} ${question}` : question;
  const scope = typeof body.scope === 'string' ? body.scope : 'all';
  let hits = [];
  try { hits = await searchForChat(req.user.id, searchText.slice(0, 1500), scope); } catch (err) { console.error('[chat search]', err.message); }
  const sources = hits.map((h, i) => ({
    n: i + 1, chunkId: Number(h.chunk_id), documentId: h.document_id, doc: h.doc, scope: h.scope, competency: h.competency,
  }));
  const excerpts = hits.map((h, i) => ({
    n: i + 1, text: h.text,
    label: h.scope === 'case_study' ? `My case study · ${h.doc}` : `RICS library · ${h.competency || 'General'} · ${h.doc}`,
  }));

  const model = await pickModel(body.model || p.chatModel || p.answerModel, config.answerModel, 'answer');
  if (model.error) return res.status(400).json({ error: model.error });
  const wantedReasoning = (typeof body.reasoning === 'string' && body.reasoning) || p.chatReasoning || config.answerReasoning;
  const reasoning = model.info
    ? reasoningParam(model.info, wantedReasoning)
    : model.id === config.answerModel ? { effort: config.answerReasoning, exclude: true } : undefined;
  const length = body.length in CHAT_LENGTHS ? body.length : 'standard';

  const messages = buildChatMessages({
    profile: req.user.profile.slice(0, 2000), notes: req.user.notes.slice(0, 40000), excerpts, history, question, length,
  });

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let reply = '';
  let cost = null;
  const started = Date.now();
  try {
    const r = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: orHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: model.id, messages, stream: true, max_tokens: 6000, ...(reasoning && { reasoning }) }),
      signal: controller.signal,
    });
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      const msg = data?.error?.message || `Chat failed (${r.status})`;
      console.error('[chat]', r.status, msg);
      return res.status(502).json({ error: msg });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { reply += delta; res.write(delta); }
          if (typeof json.usage?.cost === 'number') cost = json.usage.cost;
          if (json.error) res.write(`\n\n[error: ${json.error.message || 'unknown'}]`);
        } catch { /* partial line */ }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[chat] error', err.message);
      if (!res.headersSent) return res.status(502).json({ error: 'Chat service error: ' + err.message });
    }
  } finally {
    // Save what was written, even if the user pressed Stop
    if (reply.trim()) {
      const { rows } = await q(
        `insert into chat_messages (chat_id, role, content, sources, model) values ($1, 'assistant', $2, $3, $4) returning id`,
        [chat.id, reply, JSON.stringify(sources), model.id]);
      await q('update chats set updated_at = now() where id = $1', [chat.id]);
      recordUsage(req.user.id, 'chat', cost);
      console.log(`[chat] model=${model.id} reasoning=${reasoning?.effort || '-'} scope=${scope} excerpts=${hits.length} cost=${cost ?? '-'} ${Date.now() - started}ms`);
      if (!res.writableEnded && !controller.signal.aborted) res.end(COST_MARK + JSON.stringify({ cost, sources, messageId: Number(rows[0].id), title }));
    } else if (!res.writableEnded && res.headersSent) {
      res.end(COST_MARK + JSON.stringify({ cost, sources, messageId: null, title }));
    }
  }
});
