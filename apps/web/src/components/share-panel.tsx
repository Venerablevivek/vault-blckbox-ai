'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Check, Copy, Download, KeyRound, Link2, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import {
  api,
  ApiRequestError,
  canContribute,
  expiryLabel,
  formatDate,
  ownsOrAdministers,
  timeAgo,
  type DocumentDto,
  type Role,
  type ShareEvent,
  type ShareSummary,
} from '@/lib/api';
import { Modal, useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote, Stat } from './ui';

const EXPIRY_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Never', hours: null },
];

const LIMIT_CHOICES: Array<{ label: string; value: number | null }> = [
  { label: 'Unlimited downloads', value: null },
  { label: 'One-time link (1 download)', value: 1 },
  { label: '3 downloads', value: 3 },
  { label: '10 downloads', value: 10 },
  { label: '25 downloads', value: 25 },
];

/** More than this many distinct viewers on a one-to-one link suggests it was forwarded. */
const FORWARDING_THRESHOLD = 3;

interface CreatedLink {
  id: string;
  url: string;
  expiresAt: string | null;
  hasPassword: boolean;
  maxDownloads: number | null;
}

function limitLabel(link: { maxDownloads: number | null; downloadCount: number }): string | null {
  if (link.maxDownloads === null) return null;
  if (link.maxDownloads === 1) return link.downloadCount >= 1 ? 'One-time · used' : 'One-time';
  return `${link.downloadCount} of ${link.maxDownloads} downloads`;
}

/**
 * Share dialog, and the home of the access-visibility feature.
 *
 * Creating a link is half of it: expiry, an optional password and an optional download limit.
 * The other half answers what every sender asks afterwards: did they open it, how many people,
 * is it still live, and can I tighten it without sending a new link?
 */
export function SharePanel({
  document: doc,
  role,
  userId,
  onClose,
  onChanged,
}: {
  document: DocumentDto;
  role: Role;
  userId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialogs = useDialogs();
  const [links, setLinks] = useState<ShareSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hours, setHours] = useState<number | null>(168);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);

  const [openEvents, setOpenEvents] = useState<string | null>(null);
  const [events, setEvents] = useState<ShareEvent[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  const mayShare = canContribute(role);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ shares: ShareSummary[] }>(`/api/documents/${doc.id}/shares`);
      setLinks(data.shares);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load links.');
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createLink(event: React.FormEvent) {
    event.preventDefault();
    if (usePassword && password.length < 6) {
      setError('The link password must be at least 6 characters.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<{ share: CreatedLink }>('/api/shares', {
        documentId: doc.id,
        expiresInHours: hours,
        maxDownloads: limit,
        ...(usePassword ? { password } : {}),
      });
      setCreated(result.share);
      setCopied(false);
      setPassword('');
      setUsePassword(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create link.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(link: ShareSummary) {
    const ok = await dialogs.confirm({
      title: 'Revoke this link?',
      body: 'Anyone holding it loses access immediately. This cannot be undone; you can create a new link afterwards.',
      confirmLabel: 'Revoke link',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/shares/${link.id}`);
      if (created?.id === link.id) setCreated(null);
      toast('Link revoked', 'success');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not revoke link.');
    }
  }

  async function toggleEvents(id: string) {
    if (openEvents === id) {
      setOpenEvents(null);
      return;
    }
    setOpenEvents(id);
    setEvents([]);
    try {
      setEvents((await api.get<{ events: ShareEvent[] }>(`/api/shares/${id}/events`)).events);
    } catch {
      setEvents([]);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Share “${doc.filename}”`}
      description="Read-only links. No account needed to open them."
      size="lg"
    >
      <div className="space-y-5">
        {error ? <ErrorNote message={error} /> : null}

        {created ? (
          <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-brand-900">
              <Check className="h-4 w-4" aria-hidden /> Your link is ready
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
              Shown once — we store only a hash of it.
              {created.hasPassword ? ' Send the password separately, not in the same message.' : ''}
            </p>
          </div>
        ) : null}

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            Active links{links.length ? ` (${links.length})` : ''}
          </h3>
          {loading ? (
            <div className="mt-3 h-20 animate-pulse rounded-xl bg-slate-100" />
          ) : links.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-muted">
              No links yet.{mayShare ? ' Create one below.' : ''}
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {links.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  canManage={ownsOrAdministers(role, link.createdBy, userId)}
                  expanded={openEvents === link.id}
                  editing={editing === link.id}
                  events={events}
                  onToggleEvents={() => void toggleEvents(link.id)}
                  onEdit={() => setEditing(editing === link.id ? null : link.id)}
                  onSaved={async () => {
                    setEditing(null);
                    toast('Link updated', 'success');
                    await load();
                  }}
                  onRevoke={() => void revoke(link)}
                />
              ))}
            </ul>
          )}
        </section>

        {mayShare ? (
          <form onSubmit={createLink} className="space-y-3 border-t border-line pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">New link</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="new-expiry">
                  Expires after
                </label>
                <select
                  id="new-expiry"
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
                <label className="label" htmlFor="new-limit">
                  Downloads
                </label>
                <select
                  id="new-limit"
                  className="input"
                  value={String(limit)}
                  onChange={(e) => setLimit(e.target.value === 'null' ? null : Number(e.target.value))}
                >
                  {LIMIT_CHOICES.map((c) => (
                    <option key={c.label} value={String(c.value)}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
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
                  minLength={6}
                  maxLength={128}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="Link password"
                />
              ) : null}
            </div>
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={creating}>
                <Link2 className="h-4 w-4" aria-hidden /> {creating ? 'Creating…' : 'Create link'}
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

function LinkRow({
  link,
  canManage,
  expanded,
  editing,
  events,
  onToggleEvents,
  onEdit,
  onSaved,
  onRevoke,
}: {
  link: ShareSummary;
  canManage: boolean;
  expanded: boolean;
  editing: boolean;
  events: ShareEvent[];
  onToggleEvents: () => void;
  onEdit: () => void;
  onSaved: () => Promise<void>;
  onRevoke: () => void;
}) {
  const { activity } = link;
  const opened = activity.opens > 0 || activity.downloads > 0;
  const forwarded = activity.distinctViewers >= FORWARDING_THRESHOLD;
  const limit = limitLabel(link);

  return (
    <li className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Created {formatDate(link.createdAt)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <span>{expiryLabel(link.expiresAt)}</span>
            {link.hasPassword ? (
              <span className="chip-brand">
                <KeyRound className="h-3 w-3" aria-hidden /> Password
              </span>
            ) : null}
            {limit ? (
              <span className="chip">
                <Download className="h-3 w-3" aria-hidden /> {limit}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button className="btn-ghost btn-sm" onClick={onToggleEvents} aria-expanded={expanded}>
            <Activity className="h-3.5 w-3.5" aria-hidden /> {expanded ? 'Hide' : 'Activity'}
          </button>
          {canManage ? (
            <>
              <button className="btn-ghost btn-sm" onClick={onEdit} aria-expanded={editing}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
              </button>
              <button className="btn-ghost btn-sm hover:text-danger" onClick={onRevoke}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revoke
              </button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? <EditLink link={link} onSaved={onSaved} onCancel={onEdit} /> : null}

      <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3">
        {opened ? (
          <>
            <div className="flex gap-8">
              <Stat value={activity.opens} label="opens" />
              <Stat value={activity.downloads} label="downloads" />
              <Stat value={`~${activity.distinctViewers}`} label="viewers" />
            </div>
            {activity.lastAccessedAt ? (
              <p className="mt-2.5 text-xs text-ink-muted">
                Last opened {timeAgo(activity.lastAccessedAt)}
                {activity.firstAccessedAt ? ` · first ${formatDate(activity.firstAccessedAt)}` : ''}
              </p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink-subtle">
              Viewers are estimated by network, so the count is approximate. Repeat visits within 30 minutes and
              link-preview bots are not counted.
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Not opened yet</p>
        )}
        {forwarded ? (
          <p className="mt-3 flex gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            Opened from {activity.distinctViewers} different networks. If you sent this to one person, consider revoking
            it and issuing a new link.
          </p>
        ) : null}
        {activity.blockedAttempts > 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            {activity.blockedAttempts} blocked attempt{activity.blockedAttempts === 1 ? '' : 's'} (wrong password,
            expired or used up).
          </p>
        ) : null}
      </div>

      {expanded ? (
        <ul className="mt-3 divide-y divide-line border-t border-line text-xs">
          {events.length === 0 ? (
            <li className="py-3 text-ink-muted">No activity recorded.</li>
          ) : (
            events.map((event, index) => (
              <li key={index} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2">
                  <span
                    className={
                      event.outcome === 'downloaded'
                        ? 'chip-ok'
                        : event.outcome === 'bad_password'
                          ? 'chip-warn'
                          : 'chip'
                    }
                  >
                    {event.outcome.replace('_', ' ')}
                  </span>
                  <span className="font-mono text-ink-subtle">viewer {event.viewer}</span>
                </span>
                <span className="shrink-0 text-ink-muted">{timeAgo(event.accessedAt)}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Edits a live link in place. The URL stays the same, so the recipient keeps what they have.
 * Every field starts as "keep", so saving only sends what was actually changed.
 */
function EditLink({
  link,
  onSaved,
  onCancel,
}: {
  link: ShareSummary;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [expiry, setExpiry] = useState<string>('keep');
  const [passwordMode, setPasswordMode] = useState<'keep' | 'set' | 'remove'>('keep');
  const [password, setPassword] = useState('');
  const [limit, setLimit] = useState<string>('keep');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const changes: Record<string, unknown> = {};
    if (expiry !== 'keep') changes.expiresInHours = expiry === 'null' ? null : Number(expiry);
    if (passwordMode === 'remove') changes.password = null;
    if (passwordMode === 'set') {
      if (password.length < 6) {
        setError('The link password must be at least 6 characters.');
        return;
      }
      changes.password = password;
    }
    if (limit !== 'keep') changes.maxDownloads = limit === 'null' ? null : Number(limit);
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/shares/${link.id}`, changes);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update link.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
      {error ? <ErrorNote message={error} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`expiry-${link.id}`}>
            Expiry
          </label>
          <select id={`expiry-${link.id}`} className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="keep">Keep ({expiryLabel(link.expiresAt).toLowerCase()})</option>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.label} value={String(c.hours)}>
                {c.hours === null ? 'Never expires' : `${c.label} from now`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`limit-${link.id}`}>
            Downloads
          </label>
          <select id={`limit-${link.id}`} className="input" value={limit} onChange={(e) => setLimit(e.target.value)}>
            <option value="keep">Keep ({limitLabel(link) ?? 'unlimited'})</option>
            {LIMIT_CHOICES.map((c) => (
              <option
                key={c.label}
                value={String(c.value)}
                disabled={c.value !== null && c.value <= link.downloadCount}
              >
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`password-mode-${link.id}`}>
          Password
        </label>
        <select
          id={`password-mode-${link.id}`}
          className="input"
          value={passwordMode}
          onChange={(e) => setPasswordMode(e.target.value as 'keep' | 'set' | 'remove')}
        >
          <option value="keep">{link.hasPassword ? 'Keep the current password' : 'No password'}</option>
          <option value="set">{link.hasPassword ? 'Change the password' : 'Add a password'}</option>
          {link.hasPassword ? <option value="remove">Remove the password</option> : null}
        </select>
        {passwordMode === 'set' ? (
          <input
            type="password"
            className="input mt-2"
            placeholder="At least 6 characters"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            aria-label="New link password"
          />
        ) : null}
        {passwordMode === 'set' && link.hasPassword ? (
          <p className="mt-1 text-[11px] text-ink-subtle">
            Anyone who already unlocked the link will need the new password.
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary btn-sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
