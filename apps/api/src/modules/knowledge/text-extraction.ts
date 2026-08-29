/**
 * Text extraction — the first stage of the ingestion pipeline (docs/06 §5).
 *
 * WHAT THIS BUILD SUPPORTS, AND WHY
 *
 * Plain text and Markdown, for real. Nothing else.
 *
 * PDF was checked for first. `apps/api/src/modules/storage` stores and signs bytes but never
 * reads inside them; `apps/api/src/modules/documents` renders documents *out* of the system
 * and has no reader; no PDF library is a dependency of any workspace package. There is
 * therefore nothing to reuse, and a PDF extractor written here would either be a toy that
 * mangles two-column layouts and ligatures, or a real one that needs a vetted dependency and
 * its own decisions about scanned pages and OCR.
 *
 * So a PDF is **refused loudly**, naming the format, rather than accepted and silently
 * producing an empty or garbage document. That distinction is the whole point: a knowledge
 * base that quietly ingests a handbook as zero chunks tells a principal their handbook is
 * searchable when it is not, and the first time anyone finds out is when a parent is told the
 * school has no refund policy.
 */

import { NotImplementedError, ValidationError } from '@shikkha/shared';

export interface ExtractionInput {
  /** The original filename, used only for its extension. Never used to build a path. */
  filename: string;
  /** What the client claimed. An assertion, not a fact — the bytes decide. */
  declaredMimeType?: string | null;
  bytes: Buffer;
}

export interface ExtractedDocument {
  text: string;
  /** The MIME type determined from the bytes, not from the client's claim. */
  mimeType: string;
  /** `en` or `bn` when a script is unambiguous; null when it is mixed or undetectable. */
  language: string | null;
}

/** Formats this build reads. Anything else is refused by name. */
const SUPPORTED_MIME_TYPES = new Set(['text/plain', 'text/markdown']);

/**
 * Formats a school will plausibly try, mapped to the name used in the refusal.
 *
 * Naming the format in the error matters more than it looks: "this file type is not
 * supported" sends an administrator to the support queue, while "PDF is not supported in this
 * build — paste the text or upload a .txt/.md file" is something they can act on in a minute.
 */
const RECOGNISED_BINARY_FORMATS: { name: string; matches: (bytes: Buffer) => boolean }[] = [
  { name: 'PDF', matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    // DOCX/XLSX/PPTX are ZIP containers; so is ODT. One message covers them.
    name: 'Office Open XML (.docx/.xlsx/.pptx) or OpenDocument',
    matches: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05),
  },
  {
    name: 'legacy Microsoft Office (.doc/.xls)',
    matches: (b) =>
      b.length >= 8 &&
      b[0] === 0xd0 &&
      b[1] === 0xcf &&
      b[2] === 0x11 &&
      b[3] === 0xe0 &&
      b[4] === 0xa1 &&
      b[5] === 0xb1 &&
      b[6] === 0x1a &&
      b[7] === 0xe1,
  },
  { name: 'PNG image', matches: (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG' },
  { name: 'JPEG image', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/**
 * Turn uploaded bytes into text, or refuse.
 *
 * The order matters: recognised binary formats are named first, then anything else that looks
 * binary is refused generically, and only then is the buffer decoded. Decoding a PDF as UTF-8
 * "succeeds" — it produces a page of mojibake with a few readable strings in it — which is
 * exactly the silent-garbage outcome this function exists to prevent.
 */
export function extractText(input: ExtractionInput): ExtractedDocument {
  const bytes = input.bytes;
  if (!bytes || bytes.byteLength === 0) {
    throw new ValidationError('The uploaded file is empty', [
      { path: 'file', message: 'Upload a file with some text in it' },
    ]);
  }

  for (const format of RECOGNISED_BINARY_FORMATS) {
    if (format.matches(bytes)) {
      throw new NotImplementedError(
        `${format.name} files are not supported in this build. Upload a plain-text (.txt) or ` +
          `Markdown (.md) file, or paste the text with sourceKind=text.`,
        { detectedFormat: format.name, supported: [...SUPPORTED_MIME_TYPES] },
      );
    }
  }

  // A NUL byte in the first few kilobytes is the classic binary tell, and no legitimate UTF-8
  // text document contains one. Checking a prefix rather than the whole buffer keeps a 5 MB
  // upload cheap.
  const probe = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  if (probe.includes(0x00)) {
    throw new NotImplementedError(
      'This file appears to be binary, not text. Upload a plain-text (.txt) or Markdown (.md) ' +
        'file, or paste the text with sourceKind=text.',
      { supported: [...SUPPORTED_MIME_TYPES] },
    );
  }

  const decoded = bytes.toString('utf8');
  // U+FFFD is what Node substitutes for bytes that are not valid UTF-8. A handful can occur in
  // a legitimate document that was pasted through a broken tool; a document that is mostly
  // them was encoded in something else (very often a Windows-1252 or a legacy Bangla ASCII
  // font), and embedding it would index nonsense.
  const replacements = countReplacementChars(decoded);
  if (replacements > 0 && replacements / Math.max(decoded.length, 1) > 0.02) {
    throw new ValidationError('This file is not valid UTF-8 text', [
      {
        path: 'file',
        message:
          'Re-save the file as UTF-8. Bangla text saved in a legacy font encoding cannot be read.',
      },
    ]);
  }

  const text = normalizeText(decoded);
  if (text.trim().length === 0) {
    throw new ValidationError('The uploaded file contains no text', [
      { path: 'file', message: 'Upload a file with some text in it' },
    ]);
  }

  return {
    text,
    mimeType: looksLikeMarkdown(input.filename, text) ? 'text/markdown' : 'text/plain',
    language: detectLanguage(text),
  };
}

/**
 * Normalise text that arrived as a string rather than as bytes (the `text` and `url` source
 * kinds). Same normalisation as the upload path so the content hash of the same document is
 * the same however it was submitted — which is what makes the embedding cache hit.
 */
export function normalizeText(value: string): string {
  return (
    value
      // Strip a UTF-8 BOM: invisible, and it would change the content hash of an otherwise
      // identical document depending on which editor saved it.
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Collapse runs of blank lines to exactly one. The chunker treats a blank line as a
      // paragraph boundary, and three of them are not a stronger boundary than one.
      .replace(/\n{3,}/g, '\n\n')
      // Trailing whitespace on a line is invisible and changes the hash.
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

function countReplacementChars(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

function looksLikeMarkdown(filename: string, text: string): boolean {
  if (/\.(md|markdown)$/i.test(filename)) return true;
  // An ATX heading or a bullet list at the start of a line is enough to treat the document as
  // structured; the chunker's structural pass then has something to work with.
  return /^ {0,3}#{1,6}\s+\S/m.test(text) || /^ {0,3}[-*+]\s+\S/m.test(text);
}

/**
 * Which script the document is in.
 *
 * Not a language model — a character-range count. Bengali occupies U+0980–U+09FF. Recorded
 * for display and for a future per-language embedding route; nothing branches on it today,
 * and a wrong answer costs a label, not a retrieval.
 */
export function detectLanguage(text: string): string | null {
  let bengali = 0;
  let latin = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0x0980 && code <= 0x09ff) bengali += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
  }
  const total = bengali + latin;
  if (total < 20) return null;
  if (bengali / total > 0.6) return 'bn';
  if (latin / total > 0.6) return 'en';
  return null;
}
