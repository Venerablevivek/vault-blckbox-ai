import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * The standard PDF fonts only cover Latin-1, and drawing a character outside it throws. Anything
 * else becomes "?": the watermark's job is to identify the viewer, which an address still does.
 */
function latin1(text: string): string {
  return [...text].map((c) => (c >= ' ' && c <= '~' ? c : '?')).join('');
}

/**
 * Burns a watermark into every page of a PDF: the text in three faint slanted bands,
 * plus once small along the bottom edge. It becomes part of the page content, so saving, printing
 * or screenshotting the document keeps it.
 *
 * Throws if the PDF can't be parsed or is encrypted: callers refuse to show it rather than fall
 * back to an unmarked copy.
 */
export async function watermarkPdf(bytes: Uint8Array, text: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const mark = latin1(text);

  // Three bands at 30 degrees, a quarter, a half and three quarters of the way down each page,
  // sized so each band spans most of the page width.
  const angle = Math.PI / 6;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const fit = (width * 0.85) / Math.cos(angle) / font.widthOfTextAtSize(mark, 1);
    const size = Math.max(8, Math.min(28, fit));
    const half = font.widthOfTextAtSize(mark, size) / 2;
    for (const at of [0.25, 0.5, 0.75]) {
      page.drawText(mark, {
        x: width / 2 - half * Math.cos(angle),
        y: height * at - half * Math.sin(angle),
        size,
        font,
        color: rgb(0.45, 0.45, 0.5),
        opacity: 0.22,
        rotate: degrees(30),
      });
    }
    page.drawText(mark, {
      x: 12,
      y: 10,
      size: Math.max(6, size / 2.5),
      font,
      color: rgb(0.4, 0.4, 0.45),
      opacity: 0.7,
    });
  }
  return Buffer.from(await pdf.save());
}
