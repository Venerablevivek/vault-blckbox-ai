import sharp from 'sharp';
import { withPdf } from './pdf';

/** Longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 480;
/** Images larger than this many pixels aren't decoded at all: a guard against decompression bombs. */
const MAX_INPUT_PIXELS = 40_000_000;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function toWebp(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, failOn: 'error' })
    .rotate() // honour EXIF orientation
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 78 })
    .toBuffer();
}

/** Renders the first page of a PDF, a little over THUMBNAIL_SIZE pixels on its longest side. */
function pdfFirstPage(buffer: Buffer): Promise<Buffer> {
  return withPdf(new Uint8Array(buffer), async (pdf) => {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, (THUMBNAIL_SIZE * 1.5) / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
    page.cleanup();
    return canvas.toBuffer('image/png');
  });
}

/** A small WebP picture of a file, or null for a type we don't draw. */
export async function makeThumbnail(mimeType: string, buffer: Buffer): Promise<Buffer | null> {
  if (IMAGE_TYPES.has(mimeType)) return toWebp(buffer);
  if (mimeType === 'application/pdf') return toWebp(await pdfFirstPage(buffer));
  return null;
}
