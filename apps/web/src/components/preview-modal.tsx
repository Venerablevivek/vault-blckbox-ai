'use client';

import { Download, X } from 'lucide-react';
import type { DocumentDto } from '@/lib/api';
import { formatBytes } from '@/lib/api';

/**
 * Inline preview for PDFs and raster images.
 *
 * The iframe/img source is the API's preview route, which authorizes and then redirects to
 * a 60-second signed URL on the MinIO origin — never the app origin, so even a hostile file
 * could not reach the session cookie. The server refuses any other type.
 */
export const PREVIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function PreviewModal({ document: doc, onClose }: { document: DocumentDto; onClose: () => void }) {
  const src = `/api/documents/${doc.id}/preview`;
  const isImage = doc.mimeType.startsWith('image/');

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Preview ${doc.filename}`}>
      <div className="flex items-center gap-3 px-4 py-3 text-white sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{doc.filename}</p>
          <p className="text-xs text-slate-300">{formatBytes(doc.size)}</p>
        </div>
        <a href={`/api/documents/${doc.id}/download`} className="btn h-9 bg-white/10 text-white ring-1 ring-white/20 hover:bg-white/20">
          <Download className="h-4 w-4" aria-hidden /> Download
        </a>
        <button className="btn h-9 bg-white/10 px-2.5 text-white ring-1 ring-white/20 hover:bg-white/20" onClick={onClose} aria-label="Close preview">
          <X className="h-4 w-4" />
        </button>
      </div>
      <button className="absolute inset-0 -z-10 cursor-default" aria-hidden tabIndex={-1} onClick={onClose} />
      <div className="flex flex-1 items-center justify-center overflow-hidden px-4 pb-6 sm:px-10">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={doc.filename} className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-lift" />
        ) : (
          <iframe src={src} title={doc.filename} className="h-full w-full max-w-5xl rounded-lg bg-white shadow-lift" />
        )}
      </div>
    </div>
  );
}
