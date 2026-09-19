'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Download, Trash2, UploadCloud } from 'lucide-react';
import {
  api,
  ApiRequestError,
  formatBytes,
  formatDate,
  timeAgo,
  type DocumentDto,
  type DocumentVersion,
} from '@/lib/api';
import { Modal, useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

/**
 * A document's versions: upload a new one, download any, restore an earlier one (as a new
 * version, so nothing is lost) or delete an earlier one. Changing a document is for its uploader
 * and workspace owners; everyone else can look and download.
 */
export function VersionHistory({
  document: doc,
  canModify,
  onClose,
  onChanged,
}: {
  document: DocumentDto;
  canModify: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialogs = useDialogs();
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setVersions((await api.get<{ versions: DocumentVersion[] }>(`/api/documents/${doc.id}/versions`)).versions);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load versions.');
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`/api/documents/${doc.id}/versions`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        document?: DocumentDto;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? 'The new version could not be uploaded.');
      toast(`${doc.filename} is now version ${payload.document?.version}`, 'success');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The new version could not be uploaded.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function restore(version: DocumentVersion) {
    const ok = await dialogs.confirm({
      title: `Restore version ${version.version}?`,
      body: 'It becomes the current version. The version you have now stays in the history.',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api.post<{ document: DocumentDto }>(
        `/api/documents/${doc.id}/versions/${version.version}/restore`,
      );
      toast(`Version ${version.version} restored as version ${result.document.version}`, 'success');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not restore that version.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(version: DocumentVersion) {
    const ok = await dialogs.confirm({
      title: `Delete version ${version.version} for good?`,
      body: 'Its file is removed from storage immediately. This cannot be undone.',
      confirmLabel: 'Delete version',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/documents/${doc.id}/versions/${version.version}`);
      toast(`Version ${version.version} deleted`, 'success');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete that version.');
    } finally {
      setBusy(false);
    }
  }

  const available = (v: DocumentVersion) => v.scanStatus === 'clean' || v.scanStatus === 'unscanned';

  return (
    <Modal open onClose={onClose} title={`Versions of “${doc.filename}”`} size="lg">
      <div className="space-y-4">
        {error ? <ErrorNote message={error} /> : null}
        {canModify ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3">
            <p className="text-sm text-ink-muted">
              Upload a newer copy of this file. It must be the same type; earlier versions are kept.
            </p>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              aria-label="New version file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <button className="btn-primary btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
              <UploadCloud className="h-3.5 w-3.5" aria-hidden /> {busy ? 'Working…' : 'Upload new version'}
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="h-24 animate-pulse rounded-xl bg-surface-muted" />
        ) : (
          <ol className="divide-y divide-line rounded-xl border border-line" aria-label="Versions">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span
                  className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold ${v.current ? 'bg-brand-600 dark:bg-indigo-600 text-white' : 'bg-surface-muted text-ink-muted'}`}
                >
                  v{v.version}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {v.current ? 'Current version' : v.filename}
                    {v.scanStatus === 'pending' ? (
                      <span className="chip ml-2">Being checked</span>
                    ) : v.scanStatus === 'infected' ? (
                      <span className="chip-warn ml-2">Removed: malware</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {formatBytes(v.size)} · {v.uploadedByEmail} ·{' '}
                    <span title={formatDate(v.createdAt)}>{timeAgo(v.createdAt)}</span>
                  </p>
                </div>
                <div className="flex gap-1">
                  {available(v) ? (
                    <a
                      className="btn-ghost btn-sm"
                      href={`/api/documents/${doc.id}/versions/${v.version}/download`}
                      aria-label={`Download version ${v.version}`}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  ) : null}
                  {canModify && !v.current && available(v) ? (
                    <button className="btn-secondary btn-sm" onClick={() => void restore(v)} disabled={busy}>
                      <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> Restore
                    </button>
                  ) : null}
                  {canModify && !v.current ? (
                    <button
                      className="btn-ghost btn-sm hover:text-danger"
                      onClick={() => void remove(v)}
                      disabled={busy}
                      aria-label={`Delete version ${v.version}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="text-[11px] text-ink-subtle">
          Share links always open the current version. Every version counts towards the workspace&rsquo;s storage.
        </p>
      </div>
    </Modal>
  );
}
