/**
 * Converts an Office file to PDF with Gotenberg (LibreOffice in its own container), so it can be
 * previewed, thumbnailed and searched like a PDF. The converter only ever sees the bytes it is
 * sent; it runs with no access to storage or the database.
 */
export interface OfficeConverter {
  toPdf(filename: string, body: Buffer): Promise<Buffer>;
}

export const OFFICE_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** The extension LibreOffice needs to pick an import filter; the stored name may not have one. */
const EXTENSIONS: Record<string, string> = {
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function officeExtension(mimeType: string): string | undefined {
  return EXTENSIONS[mimeType];
}

export class GotenbergConverter implements OfficeConverter {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async toPdf(filename: string, body: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(body)]), filename);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`office conversion failed: HTTP ${response.status}`);
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('office conversion did not return a PDF');
    return pdf;
  }
}
