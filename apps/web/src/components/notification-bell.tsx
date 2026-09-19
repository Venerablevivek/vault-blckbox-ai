'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  Eye,
  FilePlus2,
  MessageSquare,
  Trash2,
  UserCheck,
  UserCog,
  UserMinus,
  type LucideIcon,
} from 'lucide-react';
import { api, timeAgo, type NotificationDto } from '@/lib/api';

export type { NotificationDto };

/** Poll interval. Long enough to be cheap, short enough to feel live. */
const POLL_MS = 20_000;

const ICONS: Record<NotificationDto['type'], { icon: LucideIcon; tone: string }> = {
  'share.first_open': { icon: Eye, tone: 'bg-ok-soft text-ok' },
  'share.new_viewer': { icon: Eye, tone: 'bg-ok-soft text-ok' },
  'share.forwarding_suspected': { icon: AlertTriangle, tone: 'bg-warn-soft text-warn' },
  'document.uploaded': { icon: FilePlus2, tone: 'bg-brand-50 text-brand-600' },
  'document.commented': { icon: MessageSquare, tone: 'bg-brand-50 text-brand-600' },
  'member.joined': { icon: UserCheck, tone: 'bg-ok-soft text-ok' },
  'member.removed': { icon: UserMinus, tone: 'bg-danger-soft text-danger' },
  'member.role_changed': {
    icon: UserCog,
    tone: 'bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300',
  },
  'workspace.deleted': { icon: Trash2, tone: 'bg-danger-soft text-danger' },
  'document.quarantined': { icon: AlertTriangle, tone: 'bg-danger-soft text-danger' },
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationDto[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ unread: number; notifications: NotificationDto[] }>('/api/notifications');
      setUnread(data.unread);
      setItems(data.notifications);
    } catch {
      // A failed refresh is not worth interrupting the user for; the next event or poll retries.
    }
  }, []);

  useEffect(() => {
    // Live updates over server-sent events: the API pushes a signal the moment a notification is
    // created, and the bell fetches the inbox. If the stream can't be used (a proxy that blocks it,
    // or too many tabs), it falls back to polling. Both stop while the tab is hidden, because
    // nobody can see the badge, and catch up as soon as it is visible again.
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;

    const startPolling = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stopPolling = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const connect = () => {
      if (source || timer || typeof EventSource === 'undefined') {
        if (typeof EventSource === 'undefined') startPolling();
        return;
      }
      source = new EventSource('/api/notifications/stream');
      // Sent on every (re)connect, so anything missed while disconnected is picked up.
      source.addEventListener('ready', () => {
        failures = 0;
        void load();
      });
      source.addEventListener('notification', () => void load());
      source.addEventListener('error', () => {
        failures += 1;
        // CLOSED means the server refused the stream outright; repeated errors mean it keeps dropping.
        if (source?.readyState === EventSource.CLOSED || failures >= 3) {
          source?.close();
          source = null;
          startPolling();
        }
      });
    };
    const disconnect = () => {
      source?.close();
      source = null;
      stopPolling();
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? connect() : disconnect());

    if (document.visibilityState === 'visible') connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  async function markAllRead() {
    await api.post('/api/notifications/read', {});
    setUnread(0);
    setItems((current) => current.map((n) => ({ ...n, read: true })));
  }

  return (
    <div className="relative">
      <button
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-600 dark:bg-indigo-600 px-1 text-[10px] font-semibold text-white ring-2 ring-surface">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            className="fixed inset-0 z-10 cursor-default"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
          />
          <div className="panel absolute right-0 z-20 mt-2 max-h-[26rem] w-80 animate-rise overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 ? (
                <button
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                  onClick={() => void markAllRead()}
                >
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
                </button>
              ) : null}
            </div>

            <div className="max-h-[21rem] overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-ink-muted">
                  Nothing yet. You will be told when someone opens a link you shared.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {items.map((item) => {
                    const href = !item.workspaceId
                      ? '#'
                      : item.type.startsWith('share.') || item.type === 'document.uploaded'
                        ? `/workspaces/${item.workspaceId}/documents`
                        : item.type.startsWith('member.')
                          ? `/workspaces/${item.workspaceId}/members`
                          : `/workspaces/${item.workspaceId}`;
                    return (
                      <li key={item.id} className={item.read ? '' : 'bg-brand-50/50'}>
                        <Link
                          href={href}
                          className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                          onClick={() => setOpen(false)}
                        >
                          {(() => {
                            const style = ICONS[item.type];
                            const Icon = style.icon;
                            return (
                              <span
                                aria-hidden
                                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.tone}`}
                              >
                                <Icon className="h-4 w-4" />
                              </span>
                            );
                          })()}
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium leading-snug">{item.title}</span>
                            {item.body ? (
                              <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{item.body}</span>
                            ) : null}
                            <span className="mt-1 block text-[11px] text-ink-subtle">{timeAgo(item.createdAt)}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
