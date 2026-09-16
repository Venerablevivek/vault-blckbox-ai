import { Errors } from './errors';

/**
 * Allowed upload types: "common document/image types", per the blueprint.
 *
 * Two deliberate exclusions:
 *  - SVG: it is an executable document (script tags, foreignObject). Allowing it would
 *    mean relying entirely on download headers to prevent stored XSS.
 *  - Archives: they hide their contents from any future scanning.
 */
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Magic-byte signatures for the binary types we accept.
 *
 * We sniff rather than trust the client's declared Content-Type, because the declared
 * value is attacker-controlled: renaming evil.exe to invoice.pdf and setting
 * application/pdf would otherwise sail straight through.
 *
 * Written by hand (rather than pulling in `file-type`) so the check is small, readable
 * and dependency-free — this is ~30 lines and covers exactly the allowlist above.
 */
type Signature = { mime: string; bytes: number[]; offset?: number };

const SIGNATURES: Signature[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { mime: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // RIFF....WEBP
  // Legacy Office (doc/xls/ppt) share the OLE compound-file header.
  { mime: 'application/x-ole-storage', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  // Modern Office (docx/xlsx/pptx) are ZIP containers.
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

/** OOXML types are ZIPs; legacy Office types are OLE. Both are accepted for their family. */
const CONTAINER_FAMILIES: Record<string, string[]> = {
  'application/zip': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  'application/x-ole-storage': [
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ],
};

/** Text formats have no magic bytes; they are validated as "no binary control characters". */
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown']);

export function detectSignature(head: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (head.length < offset + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => head[offset + i] === b)) return sig.mime;
  }
  return null;
}

function looksLikeText(head: Buffer): boolean {
  // Reject NUL and most C0 control bytes; allow tab, LF, CR and form feed.
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * Validates a declared MIME type against the first bytes of the actual file.
 * Throws a 415 AppError when they disagree or the type is not allowed.
 */
export function assertAllowedType(declared: string, head: Buffer): string {
  const mime = declared.split(';')[0]!.trim().toLowerCase();

  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw Errors.unsupportedMediaType(
      `File type "${mime}" is not allowed. Allowed types: PDF, Word, Excel, PowerPoint, text, CSV, Markdown, PNG, JPEG, GIF, WebP.`,
    );
  }

  if (TEXT_TYPES.has(mime)) {
    if (!looksLikeText(head)) {
      throw Errors.unsupportedMediaType('File content does not match the declared text type.');
    }
    return mime;
  }

  const detected = detectSignature(head);
  if (!detected) {
    throw Errors.unsupportedMediaType('File content could not be recognised.');
  }

  const family = CONTAINER_FAMILIES[detected];
  const matches = family ? family.includes(mime) : detected === mime;
  if (!matches) {
    throw Errors.unsupportedMediaType(
      `File content does not match the declared type "${mime}".`,
    );
  }

  return mime;
}
