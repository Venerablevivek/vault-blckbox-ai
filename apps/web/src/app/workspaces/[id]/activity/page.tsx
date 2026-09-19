'use client';

import { Suspense, use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Download, History, Lock, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { api, ApiRequestError, formatDate, timeAgo, type Member, type Schemas } from '@/lib/api';
import { AUDIT_STYLE, describeAuditEvent, type AuditEvent } from '@/components/audit';
import { EmptyState, ErrorNote, Shell, Skeleton, useSession } from '@/components/ui';

type Category = 'all' | 'document' | 'folder' | 'share' | 'people';

const FILTERS: Array<{ key: Category; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'document', label: 'Documents' },
  { key: 'folder', label: 'Folders' },
  { key: 'share', label: 'Share links' },
  { key: 'people', label: 'People' },
];

/** The start of a calendar day in the viewer's time zone, as an instant. */
const startOfDay = (day: string, plusDays = 0) => {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + plusDays);
  return date.toISOString();
};

export default function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <ActivityView workspaceId={id} />
    </Suspense>
  );
}

function ActivityView({ workspaceId }: { workspaceId: string }) {
  const session = useSession(workspaceId);
  const searchParams = useSearchParams();
  // Reached from a document's menu: only that document's history.
  const documentId = searchParams.get('document');
  const documentName = searchParams.get('name');

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [category, setCategory] = useState<Category>('all');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<{ members: Member[] }>(`/api/workspaces/${workspaceId}/members`)
      .then((result) => setMembers(result.members))
      .catch(() => setMembers([]));
  }, [workspaceId]);

  /** The filters as a query string, shared by the listing and the CSV export. */
  const filterQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (category !== 'all') qs.set('category', category);
    if (actorId) qs.set('actorId', actorId);
    if (documentId) qs.set('resourceId', documentId);
    if (from) qs.set('from', startOfDay(from));
    if (to) qs.set('to', startOfDay(to, 1));
    return qs.toString();
  }, [category, actorId, documentId, from, to]);
  const [verification, setVerification] = useState<Schemas['AuditVerification'] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function verifyIntegrity() {
    setVerifying(true);
    setVerifyError(null);
    try {
      setVerification(await api.get<Schemas['AuditVerification']>(`/api/workspaces/${workspaceId}/audit/verify`));
    } catch (err) {
      setVerifyError(err instanceof ApiRequestError ? err.message : 'Could not verify the audit trail.');
    } finally {
      setVerifying(false);
    }
  }

  const PAGE = 50;

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const qs = new URLSearchParams(filterQuery);
        qs.set('limit', String(PAGE));
        if (cursor) qs.set('cursor', cursor);
        const data = await api.get<{ events: AuditEvent[]; nextCursor: string | null }>(
          `/api/workspaces/${workspaceId}/audit?${qs}`,
        );
        setEvents((current) => (cursor ? [...current, ...data.events] : data.events));
        setNextCursor(data.nextCursor);
        setExhausted(data.nextCursor === null);
        setError(null);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 403) setForbidden(true);
        else if (!(err instanceof ApiRequestError && err.status === 401)) {
          setError(err instanceof ApiRequestError ? err.message : 'Failed to load activity.');
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [workspaceId, filterQuery],
  );

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const filtered = events;

  // Group by calendar day, so a long trail reads as a timeline rather than a wall.
  const groups = useMemo(() => {
    const map = new Map<string, AuditEvent[]>();
    for (const event of filtered) {
      const key = new Date(event.createdAt).toDateString();
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Activity"
      subtitle="Append-only audit trail — including anonymous access through share links"
    >
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        {error ? <ErrorNote message={error} /> : null}

        {forbidden ? (
          <div className="card">
            <EmptyState
              icon={Lock}
              title="Only workspace owners can view activity"
              hint="The trail contains every member's actions and the addresses of people who were invited but never joined."
            />
          </div>
        ) : (
          <>
            <section className="card flex flex-wrap items-start gap-3 p-4" aria-labelledby="integrity-heading">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  verification && !verification.valid ? 'bg-danger-soft text-danger' : 'bg-ok-soft text-ok'
                }`}
                aria-hidden
              >
                {verification && !verification.valid ? (
                  <ShieldAlert className="h-5 w-5" />
                ) : (
                  <ShieldCheck className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p id="integrity-heading" className="text-sm font-semibold">
                  Tamper-evident trail
                </p>
                {verifyError ? <p className="mt-0.5 text-xs text-danger">{verifyError}</p> : null}
                {!verification && !verifyError ? (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Each event is chained to the one before it by a hash, so any change, insertion or removal is
                    detectable.
                  </p>
                ) : null}
                {verification ? (
                  <div className="mt-0.5 text-xs text-ink-muted" role="status">
                    {verification.valid ? (
                      <p>
                        <span className="font-medium text-ok">Intact.</span> {verification.chainedEvents} events
                        verified
                        {verification.legacyEvents > 0
                          ? `; ${verification.legacyEvents} older events predate hashing and can't be verified`
                          : ''}
                        .
                      </p>
                    ) : (
                      <p>
                        <span className="font-medium text-danger">Broken.</span> {verification.brokenAt?.reason}. Event{' '}
                        <span className="font-mono">{verification.brokenAt?.eventId}</span>.
                      </p>
                    )}
                    {verification.head ? (
                      <p className="mt-1 break-all">
                        Latest hash <span className="font-mono">{verification.head.hash}</span>. Keep a copy elsewhere
                        to prove later that nothing after it was removed.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button className="btn-secondary btn-sm" onClick={() => void verifyIntegrity()} disabled={verifying}>
                {verifying ? 'Verifying…' : 'Verify integrity'}
              </button>
            </section>

            {documentId ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                Showing activity for <span className="font-medium">{documentName ?? 'one document'}</span>
                <Link
                  href={`/workspaces/${workspaceId}/activity`}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted hover:text-ink"
                >
                  <X className="h-3 w-3" aria-hidden /> Show everything
                </Link>
              </p>
            ) : null}

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label" htmlFor="activity-person">
                  Person
                </label>
                <select
                  id="activity-person"
                  className="input h-9 w-auto"
                  value={actorId}
                  onChange={(e) => setActorId(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="activity-from">
                  From
                </label>
                <input
                  id="activity-from"
                  type="date"
                  className="input h-9 w-auto"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="activity-to">
                  To
                </label>
                <input
                  id="activity-to"
                  type="date"
                  className="input h-9 w-auto"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              <a
                className="btn-secondary ml-auto h-9"
                href={`/api/workspaces/${workspaceId}/audit/export${filterQuery ? `?${filterQuery}` : ''}`}
                download
              >
                <Download className="h-4 w-4" aria-hidden /> Export CSV
              </a>
            </div>

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter activity">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={category === f.key}
                  onClick={() => setCategory(f.key)}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${category === f.key ? 'bg-ink text-white' : 'border border-line bg-surface text-ink-muted hover:text-ink'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="card overflow-hidden">
                <Skeleton rows={6} />
              </div>
            ) : groups.length === 0 ? (
              <div className="card">
                <EmptyState icon={History} title="No activity to show" />
              </div>
            ) : (
              groups.map(([day, dayEvents]) => (
                <section key={day}>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                    {formatDate(dayEvents[0]!.createdAt)}
                  </h2>
                  <ol className="card relative overflow-hidden">
                    {dayEvents.map((event, index) => {
                      const style = AUDIT_STYLE[event.action] ?? AUDIT_STYLE['workspace.created'];
                      const Icon = style.icon;
                      return (
                        <li key={event.id} className="relative flex gap-3.5 px-5 py-3.5">
                          {index < dayEvents.length - 1 ? (
                            <span
                              className="absolute left-[35px] top-12 h-[calc(100%-24px)] w-px bg-line"
                              aria-hidden
                            />
                          ) : null}
                          <span
                            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${style.tone}`}
                            aria-hidden
                          >
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1 pt-1">
                            <p className="text-sm leading-snug">{describeAuditEvent(event)}</p>
                            <p className="mt-0.5 text-xs text-ink-subtle">
                              {new Date(event.createdAt).toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}{' '}
                              · {timeAgo(event.createdAt)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))
            )}

            {!loading && !exhausted && events.length > 0 ? (
              <div className="flex justify-center">
                <button
                  className="btn-secondary"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    if (nextCursor) void load(nextCursor);
                  }}
                >
                  {loadingMore ? 'Loading…' : 'Load older activity'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Shell>
  );
}
