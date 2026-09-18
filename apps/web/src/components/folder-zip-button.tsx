'use client';

import { useState } from 'react';
import { FileArchive } from 'lucide-react';
import { formatBytes } from '@/lib/api';

/**
 * Downloads a shared folder (or the folder being viewed inside it) as a zip. Asks first what the
 * zip would contain, so a refusal (too large, nothing to download) is explained here rather than
 * by navigating to an error.
 */
export function FolderZipButton({ token, folderId, label }: { token: string; folderId: string | null; label: string }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
  const base = `/api/folder-shares/${encodeURIComponent(token)}/archive`;

  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${base}/summary${query}`);
      const payload = (await response.json().catch(() => ({}))) as {
        files?: number;
        bytes?: number;
        skipped?: number;
        error?: { message?: string };
      };
      if (!response.ok) {
        setMessage({ text: payload.error?.message ?? 'This folder cannot be downloaded right now.', error: true });
        return;
      }
      setMessage({
        text:
          `Downloading ${payload.files} file${payload.files === 1 ? '' : 's'} (${formatBytes(payload.bytes ?? 0)})` +
          (payload.skipped ? `. ${payload.skipped} still being checked for malware won’t be included.` : '.'),
        error: false,
      });
      window.location.assign(`${base}${query}`);
    } catch {
      setMessage({ text: 'Something went wrong. Please try again.', error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn-primary h-10 w-full" onClick={() => void download()} disabled={busy}>
        <FileArchive className="h-4 w-4" aria-hidden /> {busy ? 'Preparing…' : label}
      </button>
      {message ? (
        <p
          role={message.error ? 'alert' : 'status'}
          className={`mt-2 text-xs ${message.error ? 'text-danger' : 'text-ink-muted'}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
