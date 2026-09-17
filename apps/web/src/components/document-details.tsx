'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatBytes, formatDate, type DocumentDto } from '@/lib/api';
import { Modal } from './dialog';
import { FileGlyph } from './ui';

/**
 * A document's facts, including its SHA-256 checksum. Anyone who downloads the file can
 * compare the checksum (`shasum -a 256 file`) to confirm they have exactly the stored bytes.
 */
export function DocumentDetails({ document, onClose }: { document: DocumentDto | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copyChecksum() {
    if (!document?.sha256) return;
    await navigator.clipboard.writeText(document.sha256);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal open={document !== null} onClose={onClose} title="Document details">
      {document ? (
        <div>
          <div className="flex items-center gap-3">
            <FileGlyph filename={document.filename} mimeType={document.mimeType} />
            <p className="min-w-0 break-words text-sm font-semibold">{document.filename}</p>
          </div>
          <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-ink-muted">Type</dt>
            <dd className="break-all">{document.mimeType}</dd>
            <dt className="text-ink-muted">Size</dt>
            <dd>{formatBytes(document.size)} <span className="text-ink-subtle">({document.size.toLocaleString()} bytes)</span></dd>
            <dt className="text-ink-muted">Uploaded</dt>
            <dd>{formatDate(document.createdAt)}{document.uploadedByEmail ? ` by ${document.uploadedByEmail}` : ''}</dd>
            <dt className="text-ink-muted">SHA-256</dt>
            <dd className="min-w-0">
              {document.sha256 ? (
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-slate-50 px-2 py-1 font-mono text-[11px] leading-relaxed">{document.sha256}</code>
                  <button className="btn-ghost btn-sm shrink-0" onClick={() => void copyChecksum()} aria-label="Copy checksum">
                    {copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                </div>
              ) : (
                <span className="text-ink-muted">Being calculated…</span>
              )}
            </dd>
          </dl>
          <p className="mt-4 text-xs text-ink-subtle">
            To check a downloaded copy is intact, compare this with the output of <code className="font-mono">shasum -a 256</code>.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
