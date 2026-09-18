'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, Eye, KeyRound, Link2, Trash2 } from 'lucide-react';
import {
  api,
  ApiRequestError,
  canContribute,
  expiryLabel,
  formatDate,
  ownsOrAdministers,
  timeAgo,
  type FolderDto,
  type FolderShareSummary,
  type Role,
} from '@/lib/api';
import { Modal, useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

const EXPIRY_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Never', hours: null },
];

interface CreatedLink {
  id: string;
  url: string;
  hasPassword: boolean;
}

/**
 * Links to a whole folder. The recipient can browse it and everything below it, and download
 * single files or a zip; files added to the folder later are included, files moved out are not.
 */
export function FolderSharePanel({
  workspaceId,
  folder,
  role,
  userId,
  onClose,
}: {
  workspaceId: string;
  folder: FolderDto;
  role: Role;
  userId: string;
  onClose: () => void;
}) {
  const dialogs = useDialogs();
  const [links, setLinks] = useState<FolderShareSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState<number | null>(168);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const mayShare = canContribute(role);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ shares: FolderShareSummary[] }>(
        `/api/workspaces/${workspaceId}/folders/${folder.id}/shares`,
      );
      setLinks(result.shares);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load links.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, folder.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (usePassword && password.length < 6) {
      setError('The link password must be at least 6 characters.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<{ share: CreatedLink }>('/api/folder-shares', {
        folderId: folder.id,
        expiresInHours: hours,
        ...(usePassword ? { password } : {}),
      });
      setCreated(result.share);
      setCopied(false);
      setPassword('');
      setUsePassword(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create link.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: FolderShareSummary) {
    const ok = await dialogs.confirm({
      title: 'Revoke this folder link?',
      body: 'Anyone holding it loses access to the folder immediately.',
      confirmLabel: 'Revoke link',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/folder-shares/${link.id}`);
      if (created?.id === link.id) setCreated(null);
      toast('Link revoked', 'success');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not revoke link.');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Share the folder “${folder.name}”`}
      description="Recipients can browse this folder and everything in it, and download files. No account needed."
      size="lg"
    >
      <div className="space-y-5">
        {error ? <ErrorNote message={error} /> : null}

        {created ? (
          <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-brand-900">
              <Check className="h-4 w-4" aria-hidden /> Your folder link is ready
            </p>
            <p className="mt-2 break-all rounded-lg border border-brand-200 bg-white px-3 py-2 font-mono text-xs">
              {created.url}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                className="btn-primary btn-sm flex-1"
                onClick={() => {
                  void navigator.clipboard.writeText(created.url);
                  setCopied(true);
                }}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? 'Copied' : 'Copy link'}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
            <p className="mt-3 text-xs text-brand-900/70">
              Shown once — we store only a hash of it. Files you add to the folder later are shared too.
              {created.hasPassword ? ' Send the password separately.' : ''}
            </p>
          </div>
        ) : null}

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            Active links{links.length ? ` (${links.length})` : ''}
          </h3>
          {loading ? (
            <div className="mt-3 h-16 animate-pulse rounded-xl bg-slate-100" />
          ) : links.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-muted">
              No links to this folder yet.{mayShare ? ' Create one below.' : ''}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {links.map((link) => (
                <li
                  key={link.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Created {formatDate(link.createdAt)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                      <span>{expiryLabel(link.expiresAt)}</span>
                      {link.hasPassword ? (
                        <span className="chip-brand">
                          <KeyRound className="h-3 w-3" aria-hidden /> Password
                        </span>
                      ) : null}
                      <span className="chip">
                        <Eye className="h-3 w-3" aria-hidden /> {link.opens} open{link.opens === 1 ? '' : 's'}
                      </span>
                      <span className="chip">
                        <Download className="h-3 w-3" aria-hidden /> {link.downloads} download
                        {link.downloads === 1 ? '' : 's'}
                      </span>
                      {link.lastAccessedAt ? <span>last used {timeAgo(link.lastAccessedAt)}</span> : null}
                    </div>
                  </div>
                  {ownsOrAdministers(role, link.createdBy, userId) ? (
                    <button className="btn-ghost btn-sm hover:text-danger" onClick={() => void revoke(link)}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {mayShare ? (
          <form onSubmit={create} className="space-y-3 border-t border-line pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">New folder link</h3>
            <div>
              <label className="label" htmlFor="folder-link-expiry">
                Expires after
              </label>
              <select
                id="folder-link-expiry"
                className="input"
                value={String(hours)}
                onChange={(e) => setHours(e.target.value === 'null' ? null : Number(e.target.value))}
              >
                {EXPIRY_CHOICES.map((c) => (
                  <option key={c.label} value={String(c.hours)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={usePassword}
                  onChange={(e) => setUsePassword(e.target.checked)}
                  className="h-4 w-4 rounded border-line-strong"
                />
                Require a password
              </label>
              {usePassword ? (
                <input
                  type="password"
                  className="input mt-2"
                  placeholder="At least 6 characters"
                  value={password}
                  maxLength={128}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="Folder link password"
                />
              ) : null}
            </div>
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={creating}>
                <Link2 className="h-4 w-4" aria-hidden /> {creating ? 'Creating…' : 'Create folder link'}
              </button>
            </div>
          </form>
        ) : (
          <p className="rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-ink-muted">
            Viewers can&rsquo;t create share links. Ask a workspace owner for member access.
          </p>
        )}
      </div>
    </Modal>
  );
}
