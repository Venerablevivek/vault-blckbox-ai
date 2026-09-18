import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A real PDF with one line of text on each page. */
export async function textPdf(...pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) pdf.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 16, font });
  return Buffer.from(await pdf.save());
}
