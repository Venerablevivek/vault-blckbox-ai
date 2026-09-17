'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  Eye,
  FilePlus2,
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
  'member.joined': { icon: UserCheck, tone: 'bg-ok-soft text-ok' },
  'member.removed': { icon: UserMinus, tone: 'bg-danger-soft text-danger' },
  'member.role_changed': { icon: UserCog, tone: 'bg-violet-50 text-violet-600' },
  'workspace.deleted': { icon: Trash2, tone: 'bg-danger-soft text-danger' },
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
      // A failed poll is not worth interrupting the user for; the next tick retries.
    }
  }, []);

  useEffect(() => {
    // Polling rather than websockets: two indexed queries every twenty seconds is far cheaper
    // than the connection management a socket needs. Polling stops while the tab is hidden
    // (nobody can see the badge) and catches up immediately when the tab comes back.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
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
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-slate-100 hover:text-ink"
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
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white ring-2 ring-white">
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
                          className="flex gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
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
