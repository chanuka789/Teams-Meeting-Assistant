// Audio knowledge files: a recording (MP3, M4A, WAV…) becomes an organised, searchable document.
// 1. ffmpeg finds pauses and cuts the recording into ~8-minute pieces at pauses (no word is cut in half),
//    as small mono MP3s (speech-to-text providers time out on very long requests)
// 2. Each piece is transcribed (cheap, accurate Whisper Large V3 by default) with RICS word hints and the
//    end of the previous piece as context
// 3. A cheap model (Haiku by default) turns the transcript, part by part, into notes with headings and points,
//    using only what was said; then writes a title, summary and key terms from those notes
// 4. Notes + the full transcript are saved as the document's text and searchable chunks
// Jobs run one at a time in the background; jobs interrupted by a restart start again at start-up.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { q } from './db.js';
import { getFileStream } from './storage.js';
import { saveAudioNotes } from './documents.js';
import { config, OPENROUTER, orHeaders, pickModel, recordUsage } from './openrouter.js';
import { buildNotesMessages, buildNotesSummaryMessages, parseNotesSummary } from './prompt.js';
import { reasoningParam } from '../public/models.js';
import { speechToText } from './routes/ai.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const PIECE_SECONDS = 480;
const PART_WORDS = 1800;
const VOCAB = 'RICS APC, Quantity Surveying and Construction. NRM 1, NRM 2, NRM 3, POMI, SMM7, ICMS, JCT, NEC4, FIDIC, '
  + 'RIBA Plan of Work, BCIS, CDM, BIM, cost plan, bill of quantities, variations, valuations, final account, retention, '
  + 'liquidated damages, loss and expense, extension of time, provisional sums, preliminaries, procurement, tender.';

// ---------- pure helpers (unit tested) ----------

// "Duration: 01:02:03.45" from ffmpeg's log -> seconds
export function parseDuration(log) {
  const m = String(log).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// silencedetect log -> [{ start, end }] (the middle of each pause is a good place to cut)
export function parseSilences(log) {
  const out = [];
  let start = null;
  for (const line of String(log).split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

// Cut points about every `piece` seconds, moved to the middle of the nearest pause (within 60 s before / 30 s after)
export function cutPoints(duration, silences, piece = PIECE_SECONDS) {
  const cuts = [0];
  while (duration - cuts[cuts.length - 1] > piece * 1.25) {
    const target = cuts[cuts.length - 1] + piece;
    let best = target;
    let bestDist = Infinity;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      const d = Math.abs(mid - target);
      if (mid > target - 60 && mid < target + 30 && d < bestDist) { best = mid; bestDist = d; }
    }
    cuts.push(Math.round(best * 100) / 100);
  }
  return cuts.map((start, i) => ({ start, end: i + 1 < cuts.length ? cuts[i + 1] : duration }));
}

// Transcript -> parts of about `maxWords` words, split at sentence ends
export function splitTranscript(text, maxWords = PART_WORDS) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const parts = [];
  let cur = [];
  let words = 0;
  for (const s of sentences) {
    const n = s.split(' ').length;
    if (words + n > maxWords && cur.length) { parts.push(cur.join(' ')); cur = []; words = 0; }
    cur.push(s);
    words += n;
  }
  if (cur.length && cur.join('').trim()) parts.push(cur.join(' '));
  return parts;
}

export const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

// The finished document: title, source line, summary, key terms, the notes, then the full transcript
export function assembleNotes({ name, durationS, competency, title, summary = [], terms = [], notes = [], pieces = [] }) {
  const lines = [`# ${title || name.replace(/\.[^.]+$/, '')}`, ''];
  lines.push(`_Notes made from the audio file "${name}"${durationS ? ` (${fmtTime(durationS)})` : ''}${competency ? ` · ${competency}` : ''}. `
    + 'The full transcript is at the end._', '');
  if (summary.length) lines.push('## Summary', '', ...summary.map((x) => `- ${x}`), '');
  if (terms.length) lines.push('## Key terms', '', ...terms.map((x) => `- ${x}`), '');
  for (const n of notes) lines.push(n.trim(), '');
  lines.push('## Full transcript', '');
  for (const p of pieces) if (p.text) lines.push(`### ${fmtTime(p.start)} – ${fmtTime(p.end)}`, '', p.text.trim(), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- ffmpeg ----------

function run(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    p.stderr.on('data', (d) => { log += d; if (log.length > 4e6) log = log.slice(-2e6); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (err) => { clearTimeout(timer); reject(err); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(new Error(`ffmpeg failed (${code}): ${log.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`));
    });
  });
}

let ffmpegOk = null;
export async function audioToolAvailable() {
  if (ffmpegOk === null) ffmpegOk = await run(['-hide_banner', '-version'], { timeoutMs: 10000 }).then(() => true, () => false);
  return ffmpegOk;
}

// ---------- the job ----------

async function chat(user, modelId, fallback, messages, maxTokens) {
  const model = await pickModel(modelId, fallback, 'answer');
  if (model.error) throw new Error(model.error);
  const reasoning = model.info ? reasoningParam(model.info, 'none') : undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${OPENROUTER}/chat/completions`, {
        method: 'POST',
        headers: orHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model: model.id, messages, temperature: 0.1,
          max_tokens: maxTokens + (reasoning && reasoning.effort !== 'none' ? 4000 : 0),
          ...(reasoning && { reasoning }),
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error?.message || `Notes request failed (${r.status})`);
      const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : 0;
      recordUsage(user.id, 'knowledge', cost);
      return { text: String(data.choices?.[0]?.message?.content || '').trim(), cost };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function setProgress(id, text) {
  await q('update documents set progress = $2 where id = $1', [id, text]).catch(() => {});
}

async function processDocument(id) {
  const { rows } = await q(`select d.*, c.name as competency from documents d left join competencies c on c.id = d.competency_id where d.id = $1`, [id]);
  const doc = rows[0];
  if (!doc || doc.status !== 'processing') return;
  const { rows: users } = await q('select id, prefs from users where id = $1', [doc.uploaded_by]);
  // Costs are counted for the person who uploaded the file; their model choices are used
  const user = users[0] || { id: doc.uploaded_by, prefs: {} };
  const p = user.prefs || {};
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-'));
  let cost = 0;
  const started = Date.now();
  try {
    if (!(await audioToolAvailable())) throw new Error('Audio processing is not available on the server (ffmpeg is missing).');
    await setProgress(id, 'Preparing the audio…');
    const input = path.join(dir, `in${path.extname(doc.name) || '.audio'}`);
    const fh = await fs.open(input, 'w');
    for await (const chunk of await getFileStream(doc.storage_key)) await fh.write(chunk);
    await fh.close();

    // Length and pauses in one pass
    const log = await run(['-hide_banner', '-nostats', '-i', input, '-af', 'silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-'])
      .catch((err) => {
        console.error('[audio] read', doc.name, err.message);
        throw new Error('This file could not be read as audio. Check that it plays on your device, then upload it again.');
      });
    const duration = parseDuration(log);
    if (!duration) throw new Error('Could not read the length of this recording.');
    const pieces = cutPoints(duration, parseSilences(log));

    // Transcribe piece by piece (16 kHz mono MP3: small, and all a speech model needs)
    let previous = '';
    for (let i = 0; i < pieces.length; i++) {
      await setProgress(id, `Transcribing ${pieces.length > 1 ? `part ${i + 1} of ${pieces.length}` : 'the recording'}…`);
      const file = path.join(dir, `p${i}.mp3`);
      await run(['-hide_banner', '-y', '-ss', String(pieces[i].start), '-to', String(pieces[i].end), '-i', input,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', file]);
      const audio = (await fs.readFile(file)).toString('base64');
      let out;
      for (let attempt = 0; ; attempt++) {
        try {
          out = await speechToText(user, audio, 'mp3', {
            model: p.knowledgeSttModel, fallback: config.knowledgeSttModel, kind: 'knowledge',
            vocab: `${VOCAB}${doc.competency ? ` Topic: ${doc.competency}.` : ''}${previous ? ` Previous words: ${previous.slice(-300)}` : ''}`,
          });
          break;
        } catch (err) {
          if (attempt >= 2) throw new Error(`Transcription failed: ${err.message}`);
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
      cost += out.cost || 0;
      pieces[i].text = out.text.trim();
      previous = pieces[i].text || previous;
      await fs.rm(file, { force: true });
    }
    const transcript = pieces.map((x) => x.text).filter(Boolean).join(' ');
    if (!transcript.trim()) throw new Error('No speech was found in this recording.');

    // Organise the transcript into notes, part by part, keeping the headings consistent
    const parts = splitTranscript(transcript);
    const notes = [];
    const headings = [];
    for (let i = 0; i < parts.length; i++) {
      await setProgress(id, `Organising notes${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}…`);
      const r = await chat(user, p.knowledgeModel, config.knowledgeModel,
        buildNotesMessages({ part: parts[i], index: i, total: parts.length, competency: doc.competency, previousHeadings: headings }), 6000);
      cost += r.cost;
      const text = r.text.replace(/^#\s+.*\n/, ''); // the title is added once, at the top
      notes.push(text);
      for (const m of text.matchAll(/^##\s+(.+)$/gm)) headings.push(m[1].trim());
    }
    await setProgress(id, 'Writing the summary…');
    const sum = await chat(user, p.knowledgeModel, config.knowledgeModel, buildNotesSummaryMessages({ notes: notes.join('\n\n'), competency: doc.competency }), 1200);
    cost += sum.cost;
    const { title, summary, terms } = parseNotesSummary(sum.text);
    const text = assembleNotes({ name: doc.name, durationS: duration, competency: doc.competency, title, summary, terms, notes, pieces });
    const chunks = await saveAudioNotes(id, text, { durationS: duration, cost });
    console.log(`[audio] ${doc.name}: ${fmtTime(duration)} in ${pieces.length} pieces -> ${text.length} chars, ${chunks} chunks, cost=$${cost.toFixed(5)}, ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error('[audio]', doc.name, err.message);
    await q(`update documents set status = 'failed', progress = null, error = $2, cost = $3 where id = $1`, [id, err.message.slice(0, 300), cost || null]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// One job at a time (ffmpeg and long transcriptions are heavy), in upload order
let chain = Promise.resolve();
export function queueAudio(id) {
  chain = chain.then(() => processDocument(id)).catch((err) => console.error('[audio] job', err.message));
  return chain;
}

// Start-up: restart jobs that a restart interrupted
export async function resumeAudioJobs() {
  const { rows } = await q(`select id from documents where source = 'audio' and status = 'processing' order by id`);
  for (const r of rows) {
    await q(`update documents set progress = 'Waiting to start…' where id = $1`, [r.id]);
    queueAudio(r.id);
  }
  if (rows.length) console.log(`[audio] resumed ${rows.length} job(s)`);
}
