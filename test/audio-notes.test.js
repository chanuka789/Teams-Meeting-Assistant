// Audio knowledge files: cutting at pauses, splitting the transcript, the finished document, file types
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseSilences, cutPoints, splitTranscript, assembleNotes, fmtTime } from '../lib/audio-notes.js';
import { parseNotesSummary, buildNotesMessages, NOTES_PROMPT } from '../lib/prompt.js';
import { docKind, isAudio, mimeFor } from '../lib/extract.js';

test('reads the length and the pauses from the ffmpeg log', () => {
  const log = `Input #0, mp3\n  Duration: 01:02:03.50, start: 0.0, bitrate: 128 kb/s\n`
    + '[silencedetect @ 0x1] silence_start: 12.4\n[silencedetect @ 0x1] silence_end: 13.2 | silence_duration: 0.8\n'
    + '[silencedetect @ 0x1] silence_start: 470.1\n[silencedetect @ 0x1] silence_end: 471.0 | silence_duration: 0.9\n';
  assert.equal(parseDuration(log), 3723.5);
  assert.deepEqual(parseSilences(log), [{ start: 12.4, end: 13.2 }, { start: 470.1, end: 471 }]);
});

test('cuts about every 8 minutes, moved to the middle of a nearby pause', () => {
  const pieces = cutPoints(1500, [{ start: 470.1, end: 471 }, { start: 950, end: 951 }]);
  assert.deepEqual(pieces.map((p) => p.start), [0, 470.55, 950.5]);
  assert.equal(pieces[pieces.length - 1].end, 1500);
  // No pause nearby: cut at the target time; a short recording stays in one piece
  assert.deepEqual(cutPoints(1000, []).map((p) => p.start), [0, 480]);
  assert.deepEqual(cutPoints(500, []), [{ start: 0, end: 500 }]);
});

test('splits a long transcript into parts at sentence ends', () => {
  const sentence = 'NRM 2 sets the rules for detailed measurement of building works. ';
  const parts = splitTranscript(sentence.repeat(600), 1800);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.split(' ').length <= 1800 + 12);
    assert.match(p, /works\.$/);
  }
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), sentence.repeat(600).trim());
});

test('the finished document has the title, summary, key terms, notes and the full transcript with times', () => {
  const doc = assembleNotes({
    name: 'Lecture 3.mp3', durationS: 3723, competency: 'Quantification and costing',
    title: 'Measuring works with NRM 2', summary: ['NRM 2 is for detailed measurement.'], terms: ['**BoQ**: bill of quantities'],
    notes: ['## Purpose of NRM 2\n- Detailed measurement for bills of quantities'],
    pieces: [{ start: 0, end: 480, text: 'Good morning. NRM 2 is for detailed measurement.' }, { start: 480, end: 3723, text: 'Thank you.' }],
  });
  assert.match(doc, /^# Measuring works with NRM 2/);
  assert.match(doc, /"Lecture 3\.mp3" \(1:02:03\) · Quantification and costing/);
  assert.match(doc, /## Summary\n\n- NRM 2 is for detailed measurement\./);
  assert.match(doc, /## Key terms\n\n- \*\*BoQ\*\*/);
  assert.match(doc, /## Purpose of NRM 2/);
  assert.match(doc, /## Full transcript\n\n### 0:00 – 8:00\n\nGood morning\./);
  assert.match(doc, /### 8:00 – 1:02:03/);
  assert.equal(fmtTime(59.6), '1:00');
});

test('without a title the file name is used', () => {
  assert.match(assembleNotes({ name: 'Ethics talk.m4a', pieces: [{ start: 0, end: 10, text: 'Hi.' }] }), /^# Ethics talk\n/);
});

test('notes prompt keeps every fact and uses only what was said', () => {
  assert.match(NOTES_PROMPT, /Use ONLY what the speaker says/);
  assert.match(NOTES_PROMPT, /exactly as said/);
  const m = buildNotesMessages({ part: 'text', index: 1, total: 3, competency: 'Contract practice', previousHeadings: ['Retention'] });
  assert.match(m[1].content, /part 2 of 3/);
  assert.match(m[1].content, /Retention/);
  assert.deepEqual(parseNotesSummary('TITLE: X\nSUMMARY:\n- a\nKEY TERMS: none').terms, []);
});

test('audio file types are accepted', () => {
  for (const n of ['a.mp3', 'b.M4A', 'c.wav', 'd.ogg', 'e.webm', 'f.flac', 'g.aac', 'h.mp4']) {
    assert.equal(docKind(n), 'audio', n);
    assert.ok(isAudio(n));
  }
  assert.equal(mimeFor('x.m4a'), 'audio/mp4');
  assert.equal(isAudio('x.pdf'), false);
});
