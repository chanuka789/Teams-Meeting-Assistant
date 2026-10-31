// Text extraction for uploaded knowledge documents (PDF, Word .docx, PowerPoint .pptx, text / Markdown)

// The readers are loaded only when a file of that type is read (the PDF reader alone takes ~40 MB of memory)
const loadPdf = () => import('pdf-parse').then((m) => m.PDFParse);
const loadMammoth = () => import('mammoth').then((m) => m.default);
const loadZip = () => import('jszip').then((m) => m.default);

export const MAX_DOC_BYTES = 50 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
export const UNSUPPORTED_MSG = 'Unsupported file type. Use PDF, Word (.docx), PowerPoint (.pptx), TXT, Markdown, '
  + 'or audio (MP3, M4A, MP4, WAV, OGG, WebM, AAC, FLAC). Old .doc / .ppt files: open them and "Save as" .docx / .pptx first.';

// Audio recordings: transcribed and organised into notes (lib/audio-notes.js)
const AUDIO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', mpga: 'audio/mpeg', mpeg: 'audio/mpeg',
};
export const isAudio = (name) => Object.hasOwn(AUDIO_MIME, String(name).toLowerCase().split('.').pop());

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

const ext = (name) => String(name).toLowerCase().split('.').pop();

export function docKind(name) {
  const e = ext(name);
  if (AUDIO_MIME[e]) return 'audio';
  if (e === 'pdf' || e === 'docx' || e === 'pptx') return e;
  if (['txt', 'md', 'csv'].includes(e)) return 'text';
  return null;
}

export function mimeFor(name) {
  return MIME[ext(name)] || AUDIO_MIME[ext(name)] || 'application/octet-stream';
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

// Text of one slide XML: one line per paragraph (<a:p>), runs (<a:t>) joined
export function slideXmlToText(xml) {
  return (xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) || [])
    .map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => decodeXml(t.replace(/<\/?a:t>/g, ''))).join(''))
    .filter((line) => line.trim())
    .join('\n');
}

async function pptxToText(buffer) {
  const zip = await (await loadZip()).loadAsync(buffer);
  const num = (f) => Number(f.match(/(\d+)\.xml$/)[1]);
  const files = (re) => Object.keys(zip.files).filter((f) => re.test(f)).sort((a, b) => num(a) - num(b));
  const notes = new Map();
  for (const f of files(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)) {
    // Notes files are numbered like their slides in practically all decks
    notes.set(num(f), slideXmlToText(await zip.file(f).async('string')).replace(/^\d+$/m, '').trim());
  }
  const out = [];
  for (const f of files(/^ppt\/slides\/slide\d+\.xml$/)) {
    const n = num(f);
    const text = slideXmlToText(await zip.file(f).async('string'));
    const note = notes.get(n);
    out.push(`Slide ${n}\n${text}${note ? `\nSpeaker notes: ${note}` : ''}`);
  }
  return out.join('\n\n');
}

// Collapse the spacing PDFs and Word files produce, keeping paragraph breaks
export function cleanText(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/-- \d+ of \d+ --/g, '')   // pdf-parse page markers
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractText(name, buffer) {
  const kind = docKind(name);
  if (kind === 'pdf') {
    const PDFParse = await loadPdf();
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      return cleanText((await parser.getText()).text);
    } finally {
      await parser.destroy();
    }
  }
  if (kind === 'docx') return cleanText((await (await loadMammoth()).extractRawText({ buffer })).value);
  if (kind === 'pptx') return cleanText(await pptxToText(buffer));
  if (kind === 'text') return cleanText(buffer.toString('utf8'));
  throw new Error(UNSUPPORTED_MSG);
}
