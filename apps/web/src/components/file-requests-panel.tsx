'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Inbox } from 'lucide-react';
import { api, ApiRequestError, formatBytes, formatDate, timeAgo, type Schemas } from '@/lib/api';
import { Modal, useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

type FileRequest = Schemas['FileRequestSummary'];
type ReceivedFile = Schemas['ReceivedFile'];

const STATUS: Record<FileRequest['status'], { label: string; className: string }> = {
  open: { label: 'Open', className: 'chip-ok' },
  full: { label: 'Complete', className: 'chip' },
  expired: { label: 'Expired', className: 'chip' },
  revoked: { label: 'Closed', className: 'chip' },
};

function Received({ requestId }: { requestId: string }) {
  const [files, setFiles] = useState<ReceivedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ files: ReceivedFile[] }>(`/api/file-requests/${requestId}/files`)
      .then((r) => setFiles(r.files))
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : 'Could not load files.'));
  }, [requestId]);
  if (error) return <p className="px-4 pb-3 text-xs text-danger">{error}</p>;
  if (!files) return <div className="mx-4 mb-3 h-10 animate-pulse rounded-lg bg-surface-muted" />;
  if (files.length === 0) return <p className="px-4 pb-3 text-xs text-ink-muted">Nothing received yet.</p>;
  return (
    <ul className="mx-4 mb-3 divide-y divide-line rounded-lg border border-line" aria-label="Received files">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 truncate font-medium text-ink">{f.filename}</span>
          <span className="text-ink-muted">
            {f.senderName}
            {f.senderEmail ? ` <${f.senderEmail}>` : ''} · {formatBytes(f.size)} ·{' '}
            <span title={formatDate(f.receivedAt)}>{timeAgo(f.receivedAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Upload links for people outside the workspace. Create one for the folder you are in, copy
 * the link (shown once: only its hash is kept), and see what each request has received.
 */
export function FileRequestsPanel({
  workspaceId,
  folder,
  onClose,
}: {
  workspaceId: string;
  folder: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const dialogs = useDialogs();
  const [requests, setRequests] = useState<FileRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(7);
  const [maxFiles, setMaxFiles] = useState('');
  const [created, setCreated] = useState<{ url: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequests(
        (await api.get<{ requests: FileRequest[] }>(`/api/workspaces/${workspaceId}/file-requests`)).requests,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load file requests.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const limit = maxFiles.trim() ? Number(maxFiles) : null;
      const result = await api.post<{ request: FileRequest; url: string }>(
        `/api/workspaces/${workspaceId}/file-requests`,
        {
          title: title.trim(),
          message: message.trim() || null,
          folderId: folder?.id ?? null,
          expiresInDays: days,
          maxFiles: limit,
        },
      );
      setCreated({ url: result.url, title: result.request.title });
      setCopied(false);
      setTitle('');
      setMessage('');
      setMaxFiles('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the request.');
    } finally {
      setBusy(false);
    }
  }

  async function close(request: FileRequest) {
    const ok = await dialogs.confirm({
      title: `Close “${request.title}”?`,
      body: 'The link stops accepting files straight away. Files already received stay where they are.',
      confirmLabel: 'Close request',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/file-requests/${request.id}`);
      toast('File request closed', 'success');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not close the request.');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="File requests"
      description="Let people without an account send files into this workspace. They can't see anything already here."
      size="lg"
    >
      <div className="space-y-5">
        {error ? <ErrorNote message={error} /> : null}

        {created ? (
          <div className="space-y-2 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3" role="status">
            <p className="text-sm font-medium text-ok">
              “{created.title}” is ready. Copy the link now: it won&rsquo;t be shown again.
            </p>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" readOnly value={created.url} aria-label="Request link" />
              <button
                type="button"
                className="btn-secondary btn-sm shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(created.url);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        ) : null}

        <form className="space-y-3 rounded-xl border border-line p-4" onSubmit={(e) => void create(e)}>
          <p className="text-sm font-medium">
            New request into{' '}
            <span className="text-brand-700 dark:text-indigo-300">{folder ? folder.name : 'the top level'}</span>
          </p>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-ink-muted">Title</span>
            <input
              className="input"
              required
              maxLength={120}
              placeholder="e.g. Signed contract and ID"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-ink-muted">Message (optional)</span>
            <textarea
              className="input min-h-16"
              maxLength={1000}
              placeholder="What should they send?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">Open for</span>
              <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 3, 7, 14, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-ink-muted">File limit (optional)</span>
              <input
                className="input"
                type="number"
                min={1}
                max={500}
                placeholder="No limit"
                value={maxFiles}
                onChange={(e) => setMaxFiles(e.target.value)}
              />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary btn-sm" disabled={busy || !title.trim()}>
              <Inbox className="h-3.5 w-3.5" aria-hidden /> {busy ? 'Creating…' : 'Create request'}
            </button>
          </div>
        </form>

        {loading ? (
          <div className="h-20 animate-pulse rounded-xl bg-surface-muted" />
        ) : requests.length === 0 ? (
          <p className="text-center text-sm text-ink-muted">No file requests yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="File requests">
            {requests.map((r) => (
              <li key={r.id}>
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    aria-expanded={expanded === r.id}
                    aria-label={`Files received for ${r.title}`}
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  >
                    {expanded === r.id ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {r.title} <span className={`${STATUS[r.status].className} ml-1`}>{STATUS[r.status].label}</span>
                    </p>
                    <p className="text-xs text-ink-muted">
                      {r.receivedCount}
                      {r.maxFiles !== null ? ` of ${r.maxFiles}` : ''} received · into {r.folderName ?? 'the top level'}{' '}
                      · {r.createdByEmail} ·{' '}
                      {r.status === 'open' ? `open until ${formatDate(r.expiresAt)}` : `made ${timeAgo(r.createdAt)}`}
                    </p>
                  </div>
                  {r.canManage && r.status !== 'revoked' && r.status !== 'expired' ? (
                    <button type="button" className="btn-ghost btn-sm hover:text-danger" onClick={() => void close(r)}>
                      Close
                    </button>
                  ) : null}
                </div>
                {expanded === r.id ? <Received requestId={r.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
