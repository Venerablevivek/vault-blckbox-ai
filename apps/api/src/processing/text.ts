import yauzl from 'yauzl';
import { withPdf } from './pdf';

/** Most text kept per document: enough to search a long report, bounded for the database. */
export const MAX_TEXT_CHARS = 200_000;
/** Most pages of a PDF read for text. */
const MAX_PDF_PAGES = 200;

const OFFICE_TEXT_ENTRIES: Record<string, RegExp> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    /^word\/(document|header\d*|footer\d*)\.xml$/,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': /^ppt\/slides\/slide\d+\.xml$/,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': /^xl\/sharedStrings\.xml$/,
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text inside Office XML: runs of text between tags, with paragraph ends as line breaks. */
export function xmlText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|si)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
      const code = body.startsWith('#x')
        ? parseInt(body.slice(2), 16)
        : body.startsWith('#')
          ? Number(body.slice(1))
          : NaN;
      if (Number.isInteger(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      return ENTITIES[body] ?? entity;
    });
}

/** Normalises whitespace and caps the length; control characters other than line breaks become spaces. */
export function tidyText(text: string): string {
  return text
    .replace(/(?![\n\t])\p{Cc}/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** Reads the matching entries of a zip (an Office file) as text, stopping at MAX_TEXT_CHARS. */
function officeText(buffer: Buffer, entries: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('not a zip'));
      const parts: string[] = [];
      let length = 0;
      zip.on('entry', (entry: yauzl.Entry) => {
        // The declared size is checked before inflating anything, against zip bombs; yauzl also
        // stops a stream that inflates past what its entry declared.
        if (!entries.test(entry.fileName) || entry.uncompressedSize > 50 * 1024 * 1024 || length >= MAX_TEXT_CHARS) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('unreadable entry'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            const text = xmlText(Buffer.concat(chunks).toString('utf8'));
            parts.push(text);
            length += text.length;
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(parts.join('\n')));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function pdfText(buffer: Buffer): Promise<string> {
  return withPdf(new Uint8Array(buffer), async (pdf) => {
    const parts: string[] = [];
    let length = 0;
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES) && length < MAX_TEXT_CHARS; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('');
      parts.push(text);
      length += text.length;
      page.cleanup();
    }
    return parts.join('\n');
  });
}

/**
 * The searchable text of a file, or null for a type we don't read (images, legacy Office).
 * Throws if a file of a readable type can't be parsed.
 */
export async function extractText(mimeType: string, buffer: Buffer): Promise<string | null> {
  if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/markdown') {
    return tidyText(buffer.toString('utf8'));
  }
  if (mimeType === 'application/pdf') return tidyText(await pdfText(buffer));
  const entries = OFFICE_TEXT_ENTRIES[mimeType];
  if (entries) return tidyText(await officeText(buffer, entries));
  return null;
}
