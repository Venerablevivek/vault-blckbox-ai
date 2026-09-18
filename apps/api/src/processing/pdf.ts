import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * pdf.js ships as an ES module only. This project compiles to CommonJS, where the import below
 * becomes require(): Node 22.12+ loads an ES module that way (pdf.js has no top-level await).
 * Loaded on first use, so the API process never pays for it; only the worker processes PDFs.
 */
let loaded: Promise<typeof PdfJs> | null = null;
function pdfjs(): Promise<typeof PdfJs> {
  loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return loaded;
}

/**
 * Runs `use` on an untrusted PDF and always releases it afterwards. pdf.js never runs a document's
 * JavaScript, XFA forms are off, and nothing is fetched from anywhere else.
 */
export async function withPdf<T>(data: Uint8Array, use: (pdf: PdfJs.PDFDocumentProxy) => Promise<T>): Promise<T> {
  const { getDocument } = await pdfjs();
  const task = getDocument({
    data,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    return await use(await task.promise);
  } finally {
    await task.destroy();
  }
}
