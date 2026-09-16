'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiRequestError,
  expiryLabel,
  formatDate,
  timeAgo,
  type DocumentDto,
  type ShareEvent,
  type ShareSummary,
} from '@/lib/api';
import { ErrorNote, Stat } from './ui';

const EXPIRY_CHOICES = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Never', hours: null },
];

/** More than this many distinct viewers on a one-to-one link suggests it was forwarded. */
const FORWARDING_THRESHOLD = 3;

interface CreatedLink {
  id: string;
  url: string;
  expiresAt: string | null;
}

/**
 * Share dialog, and the home of the access-visibility feature.
 *
 * Creating a link is half of it; the other half is answering the question every sender
 * actually has afterwards — did they open it, how many people, and is it still live?
 */
export function SharePanel({
  document: doc,
  onClose,
  onChanged,
}: {
  document: DocumentDto;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<ShareSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [hours, setHours] = useState<number | null>(168);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);

  const [openEvents, setOpenEvents] = useState<string | null>(null);
  const [events, setEvents] = useState<ShareEvent[]>([]);

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

  async function createLink() {
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<{ share: CreatedLink }>('/api/shares', {
        documentId: doc.id,
        expiresInHours: hours,
      });
      setCreated(result.share);
      setCopied(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create link.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this link? Anyone holding it loses access immediately.')) return;
    try {
      await api.del(`/api/shares/${id}`);
      if (created?.id === id) setCreated(null);
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
      const data = await api.get<{ events: ShareEvent[] }>(`/api/shares/${id}/events`);
      setEvents(data.events);
    } catch {
      setEvents([]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="panel max-h-[86vh] w-full max-w-lg animate-rise overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${doc.filename}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Share “{doc.filename}”</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              Read-only links. No account needed to open them.
            </p>
          </div>
          <button className="btn-ghost -mr-1.5 -mt-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {error ? <ErrorNote message={error} /> : null}

          {created ? (
            <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
              <p className="text-sm font-medium text-brand-900">Your link is ready</p>
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
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button className="btn-secondary btn-sm" onClick={() => setCreated(null)}>
                  Done
                </button>
              </div>
              {/* Only a hash is stored, so this really is the one chance to copy it.
                  Saying so explains the security model better than a README paragraph. */}
              <p className="mt-3 text-xs text-brand-900/70">
                Shown once — we store only a hash of it. You can always revoke it and make a new one.
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
                No links yet. Create one below.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {links.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    expanded={openEvents === link.id}
                    events={events}
                    onToggleEvents={() => void toggleEvents(link.id)}
                    onRevoke={() => void revoke(link.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="border-t border-line pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              New link
            </h3>
            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <label className="label" htmlFor="expiry">
                  Expires after
                </label>
                <select
                  id="expiry"
                  className="input"
                  value={String(hours)}
                  onChange={(event) =>
                    setHours(event.target.value === 'null' ? null : Number(event.target.value))
                  }
                >
                  {EXPIRY_CHOICES.map((choice) => (
                    <option key={choice.label} value={String(choice.hours)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary h-10" onClick={() => void createLink()} disabled={creating}>
                {creating ? 'Creating…' : 'Create link'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function LinkRow({
  link,
  expanded,
  events,
  onToggleEvents,
  onRevoke,
}: {
  link: ShareSummary;
  expanded: boolean;
  events: ShareEvent[];
  onToggleEvents: () => void;
  onRevoke: () => void;
}) {
  const { activity } = link;
  const opened = activity.opens > 0;
  const forwarded = activity.distinctViewers >= FORWARDING_THRESHOLD;

  return (
    <li className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Created {formatDate(link.createdAt)}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{expiryLabel(link.expiresAt)}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button className="btn-ghost btn-sm" onClick={onToggleEvents}>
            {expanded ? 'Hide' : 'Activity'}
          </button>
          <button className="btn-ghost btn-sm hover:text-danger" onClick={onRevoke}>
            Revoke
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3">
        {opened ? (
          <>
            <div className="flex gap-8">
              <Stat value={activity.opens} label="opens" />
              <Stat value={`~${activity.distinctViewers}`} label="viewers" />
            </div>
            <p className="mt-2.5 text-xs text-ink-muted">
              Last opened {timeAgo(activity.lastAccessedAt!)}
              {activity.firstAccessedAt
                ? ` · first ${formatDate(activity.firstAccessedAt)}`
                : ''}
            </p>
            {/* Viewer counts are estimated from network, not identity. Saying so is more
                honest than presenting an approximation as a fact. */}
            <p className="mt-1 text-[11px] text-ink-subtle">
              Viewers are estimated by network, so the count is approximate.
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            Not opened yet
            <span className="text-ink-subtle"> · nobody has used this link</span>
          </p>
        )}

        {forwarded ? (
          <p className="mt-3 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
            Opened from {activity.distinctViewers} different networks. If you sent this to one
            person, consider revoking it and issuing a new link.
          </p>
        ) : null}

        {activity.blockedAttempts > 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            {activity.blockedAttempts} attempt
            {activity.blockedAttempts === 1 ? '' : 's'} after it stopped working.
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
                  <span className={event.outcome === 'downloaded' ? 'chip-ok' : 'chip'}>
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
