// Text extraction for uploaded knowledge documents (PDF, Word .docx, plain text / Markdown)

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export const MAX_DOC_BYTES = 20 * 1024 * 1024;

export function docKind(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['txt', 'md', 'csv'].includes(ext)) return 'text';
  return null;
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
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      return cleanText((await parser.getText()).text);
    } finally {
      await parser.destroy();
    }
  }
  if (kind === 'docx') return cleanText((await mammoth.extractRawText({ buffer })).value);
  if (kind === 'text') return cleanText(buffer.toString('utf8'));
  throw new Error('Unsupported file type. Use PDF, Word (.docx), TXT or Markdown.');
}
