'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { History, Lock } from 'lucide-react';
import { api, ApiRequestError, formatDate, timeAgo } from '@/lib/api';
import { AUDIT_STYLE, describeAuditEvent, type AuditEvent } from '@/components/audit';
import { EmptyState, ErrorNote, Shell, Skeleton, useSession } from '@/components/ui';

type Category = 'all' | 'document' | 'share' | 'member';

const FILTERS: Array<{ key: Category; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'document', label: 'Documents' },
  { key: 'share', label: 'Share links' },
  { key: 'member', label: 'People' },
];

export default function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);
  const session = useSession(workspaceId);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [category, setCategory] = useState<Category>('all');

  const PAGE = 50;

  const load = useCallback(
    async (before?: string) => {
      try {
        const qs = new URLSearchParams({ limit: String(PAGE), ...(before ? { before } : {}) });
        const data = await api.get<{ events: AuditEvent[] }>(`/api/workspaces/${workspaceId}/audit?${qs}`);
        setEvents((current) => (before ? [...current, ...data.events] : data.events));
        setExhausted(data.events.length < PAGE);
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
    [workspaceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = events.filter((e) =>
    category === 'all'
      ? true
      : category === 'member'
        ? /^(member|invitation|workspace)\./.test(e.action)
        : e.action.startsWith(`${category}.`),
  );

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
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter activity">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={category === f.key}
                  onClick={() => setCategory(f.key)}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${category === f.key ? 'bg-ink text-white' : 'border border-line bg-white text-ink-muted hover:text-ink'}`}
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
                            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-white ${style.tone}`}
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
                    void load(events[events.length - 1]!.createdAt);
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
