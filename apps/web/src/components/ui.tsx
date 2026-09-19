'use client';

import Link from 'next/link';
import { ThemeSwitch } from './theme';
import { CommandMenu } from './command-menu';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { api, ApiRequestError, formatBytes, type Role, type Schemas, type Workspace } from '@/lib/api';
import { useDialogs } from './dialog';
import { Brand } from './brand';
import { NotificationBell } from './notification-bell';
import { Toaster, toast } from './toast';
import { VerifyEmailBanner } from './verify-email-banner';

export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  icon: Icon = FileText,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">{hint}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-surface-muted" />
          <div className="ml-auto h-3 w-20 animate-pulse rounded bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const label = role === 'OWNER' ? 'Owner' : role === 'MEMBER' ? 'Member' : 'Viewer';
  return <span className={role === 'OWNER' ? 'chip-brand' : role === 'VIEWER' ? 'chip-warn' : 'chip'}>{label}</span>;
}

/**
 * File glyph. The extension is the icon — instantly readable, no image assets — and the
 * colour groups documents, sheets and images at a glance.
 */
const FILE_TONES: Array<[RegExp, string]> = [
  [/pdf/, 'from-rose-500 to-rose-600'],
  [/sheet|excel|csv/, 'from-emerald-500 to-emerald-600'],
  [/word|document/, 'from-blue-500 to-blue-600'],
  [/presentation|powerpoint/, 'from-amber-500 to-amber-600'],
  [/image|png|jpeg|gif|webp/, 'from-violet-500 to-violet-600'],
];

export function FileGlyph({
  filename,
  mimeType,
  size = 'md',
}: {
  filename: string;
  mimeType: string;
  size?: 'sm' | 'md';
}) {
  const ext = (filename.split('.').pop() ?? '?').slice(0, 4).toUpperCase();
  const tone = FILE_TONES.find(([pattern]) => pattern.test(mimeType))?.[1] ?? 'from-slate-400 to-slate-500';
  const box = size === 'sm' ? 'h-8 w-8 text-[8px]' : 'h-10 w-10 text-[9px]';
  return (
    <span
      aria-hidden
      className={`inline-flex ${box} shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${tone} font-bold tracking-tight text-white shadow-sm`}
    >
      {ext}
    </span>
  );
}

/** Small labelled figure. Label sentence-case, value in ink — never in a data colour. */
export function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <p className="text-lg font-semibold leading-none">{value}</p>
      <p className="mt-1 text-xs text-ink-muted">{label}</p>
    </div>
  );
}

/**
 * How much of the workspace's storage is used. Turns amber past 80% and red past 95%, and says
 * so in words too, so the state never depends on colour alone.
 */
export function StorageMeter({
  usedBytes,
  quotaBytes,
  compact = false,
}: {
  usedBytes: number;
  quotaBytes: number;
  compact?: boolean;
}) {
  const ratio = quotaBytes > 0 ? Math.min(1, usedBytes / quotaBytes) : 0;
  const percent = Math.round(ratio * 100);
  const state = ratio >= 0.95 ? 'full' : ratio >= 0.8 ? 'high' : 'ok';
  const bar = state === 'full' ? 'bg-danger' : state === 'high' ? 'bg-warn' : 'bg-brand-600 dark:bg-indigo-600';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-ink-muted">
          <span className="font-medium text-ink">{formatBytes(usedBytes)}</span> of {formatBytes(quotaBytes)} used
        </span>
        <span
          className={
            state === 'ok' ? 'text-ink-subtle' : state === 'high' ? 'font-medium text-warn' : 'font-medium text-danger'
          }
        >
          {state === 'full' ? 'Almost full' : state === 'high' ? 'Running low' : `${percent}%`}
        </span>
      </div>
      <div
        className={`mt-1.5 overflow-hidden rounded-full bg-surface-muted ${compact ? 'h-1.5' : 'h-2'}`}
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used`}
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(ratio > 0 ? 1 : 0, percent)}%` }} />
      </div>
    </div>
  );
}

/** Deterministic colour per workspace, so the same workspace always looks the same. */
const WORKSPACE_TONES = [
  'from-indigo-500 to-violet-600',
  'from-sky-500 to-blue-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-600',
  'from-rose-500 to-pink-600',
];

export function WorkspaceAvatar({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' }) {
  const tone = WORKSPACE_TONES[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % WORKSPACE_TONES.length];
  const box = size === 'sm' ? 'h-6 w-6 text-[10px] rounded-md' : 'h-8 w-8 text-xs rounded-lg';
  return (
    <span
      aria-hidden
      className={`inline-flex ${box} shrink-0 items-center justify-center bg-gradient-to-br ${tone} font-semibold text-white`}
    >
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
  exact?: boolean;
}

/**
 * Application shell: a sidebar with a workspace switcher and icon navigation, a header,
 * and the page. The workspace you are in and the role you hold stay visible at all times —
 * a permissions decision as much as a layout one.
 */
export function Shell({
  workspaces,
  activeId,
  email,
  title,
  subtitle,
  actions,
  children,
}: {
  workspaces: Workspace[];
  activeId: string;
  email: string;
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const emailVerified = useEmailVerified();
  const active = workspaces.find((w) => w.id === activeId);
  const pathname = usePathname();
  const router = useRouter();

  const dialogs = useDialogs();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);

  // ⌘K (Ctrl+K elsewhere) opens the command menu from anywhere in the app, even while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [pathname]);

  const nav: NavItem[] = [
    { href: `/workspaces/${activeId}`, label: 'Overview', icon: LayoutDashboard, exact: true },
    { href: `/workspaces/${activeId}/documents`, label: 'Documents', icon: FileText },
    { href: `/workspaces/${activeId}/members`, label: 'Members', icon: Users },
    // Owner-only server-side too; hiding it keeps the nav from offering a link that 403s.
    { href: `/workspaces/${activeId}/activity`, label: 'Activity', icon: History, ownerOnly: true },
    { href: `/workspaces/${activeId}/settings`, label: 'Settings', icon: Settings },
  ];

  async function createWorkspace() {
    setSwitcherOpen(false);
    const name = await dialogs.prompt({
      title: 'New workspace',
      body: 'A separate space with its own documents, members and share links.',
      label: 'Workspace name',
      placeholder: 'e.g. Marketing',
      confirmLabel: 'Create workspace',
      maxLength: 120,
    });
    if (!name) return;
    try {
      const result = await api.post<{ workspace: { id: string } }>('/api/workspaces', { name: name.trim() });
      toast(`Created “${name.trim()}”`, 'success');
      router.push(`/workspaces/${result.workspace.id}`);
    } catch (error) {
      toast(error instanceof ApiRequestError ? error.message : 'Could not create workspace.', 'error');
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center justify-between px-5">
        <Brand href="/" />
        <button className="btn-ghost lg:hidden" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Workspace switcher */}
      <div className="relative px-3">
        <button
          className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 py-2 text-left shadow-card transition-colors hover:border-line-strong"
          onClick={() => setSwitcherOpen((open) => !open)}
          aria-haspopup="listbox"
          aria-expanded={switcherOpen}
        >
          {active ? <WorkspaceAvatar id={active.id} name={active.name} /> : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{active?.name ?? 'Workspace'}</span>
            <span className="block text-[11px] text-ink-muted">
              {active?.role === 'OWNER' ? 'Owner' : active?.role === 'VIEWER' ? 'Viewer · read only' : 'Member'}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 text-ink-subtle" aria-hidden />
        </button>

        {switcherOpen ? (
          <>
            <button
              className="fixed inset-0 z-10 cursor-default"
              aria-hidden
              tabIndex={-1}
              onClick={() => setSwitcherOpen(false)}
            />
            <div className="panel absolute left-3 right-3 z-20 mt-2 animate-rise p-1.5" role="listbox">
              <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                Workspaces
              </p>
              {workspaces.map((w) => (
                <Link
                  key={w.id}
                  href={`/workspaces/${w.id}`}
                  onClick={() => setSwitcherOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-muted"
                  role="option"
                  aria-selected={w.id === activeId}
                >
                  <WorkspaceAvatar id={w.id} name={w.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.id === activeId ? <Check className="h-4 w-4 text-brand-600" aria-hidden /> : null}
                </Link>
              ))}
              <div className="my-1 h-px bg-line" />
              <button
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
                onClick={() => void createWorkspace()}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-line-strong">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </span>
                New workspace
              </button>
            </div>
          </>
        ) : null}
      </div>

      <nav className="mt-5 flex-1 space-y-0.5 px-3" aria-label="Workspace">
        <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Menu</p>
        {nav
          .filter((item) => !item.ownerOnly || active?.role === 'OWNER')
          .map((item) => {
            const selected = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={selected ? 'page' : undefined}
                className={`group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  selected
                    ? 'bg-brand-600 dark:bg-indigo-600 font-medium text-white shadow-sm'
                    : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
                }`}
              >
                <Icon
                  className={`h-[18px] w-[18px] ${selected ? 'text-white' : 'text-ink-subtle group-hover:text-ink'}`}
                  aria-hidden
                />
                {item.label}
              </Link>
            );
          })}
      </nav>

      <div className="m-3 rounded-xl bg-gradient-to-br from-brand-600 dark:from-indigo-600 to-violet-600 p-4 text-white">
        <p className="text-sm font-semibold">Share with confidence</p>
        <p className="mt-1 text-xs leading-relaxed text-indigo-100">
          Every link is revocable, can expire, and tells you when it&rsquo;s opened.
        </p>
      </div>

      <div className="border-t border-line px-4 pt-3">
        <ThemeSwitch />
      </div>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <Link
          href={`/workspaces/${activeId}/account`}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 -m-1 hover:bg-surface-muted"
          aria-current={pathname.endsWith('/account') ? 'page' : undefined}
          title="Account: password and sessions"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
            {email.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-ink" title={email}>
              {email}
            </span>
            <span className="block text-[11px] text-ink-subtle">Account &amp; security</span>
          </span>
        </Link>
        <button className="btn-ghost h-8 px-2" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-line bg-surface/70 backdrop-blur lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button className="absolute inset-0 bg-ink/30" aria-label="Close menu" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-rise bg-surface shadow-lift">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {emailVerified === false && email ? <VerifyEmailBanner email={email} /> : null}
        <header className="sticky top-0 z-20 border-b border-line/80 bg-surface/80 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button className="btn-ghost lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">{title ?? active?.name}</h1>
              {subtitle ? <p className="hidden truncate text-xs text-ink-muted sm:block">{subtitle}</p> : null}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {actions}
              <button
                className="btn-ghost h-9 gap-2 px-2.5"
                onClick={() => setCommandsOpen(true)}
                aria-label="Open the command menu"
                aria-keyshortcuts="Meta+K Control+K"
                title="Command menu (⌘K)"
              >
                <Search className="h-4 w-4" aria-hidden />
                <kbd className="hidden rounded border border-line-strong px-1.5 text-[10px] text-ink-subtle md:inline">
                  ⌘K
                </kbd>
              </button>
              <NotificationBell />
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>
        <CommandMenu
          open={commandsOpen}
          onClose={() => setCommandsOpen(false)}
          workspaceId={activeId}
          workspaces={workspaces}
          signOut={() => void signOut()}
        />

        <footer className="border-t border-line/80 px-6 py-4 text-xs text-ink-subtle">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium text-ink-muted">Vault</span> · documents, workspaces and revocable share
              links
            </span>
            <span className="flex gap-4">
              <a className="hover:text-ink" href="http://localhost:4000/health" target="_blank" rel="noreferrer">
                API status
              </a>
              <a className="hover:text-ink" href="http://localhost:9001" target="_blank" rel="noreferrer">
                Object storage
              </a>
            </span>
          </div>
        </footer>
      </div>

      <Toaster />
    </div>
  );
}

/**
 * Whether the signed-in account has confirmed its email, shared between useSession (which loads
 * it) and the Shell (which shows the banner), without threading a prop through every page.
 */
let emailVerifiedState: boolean | null = null;
const emailVerifiedListeners = new Set<() => void>();
function setEmailVerified(value: boolean) {
  emailVerifiedState = value;
  emailVerifiedListeners.forEach((listener) => listener());
}
function useEmailVerified(): boolean | null {
  return useSyncExternalStore(
    (listener) => {
      emailVerifiedListeners.add(listener);
      return () => emailVerifiedListeners.delete(listener);
    },
    () => emailVerifiedState,
    () => null,
  );
}

/** Shared loader for pages inside the shell: current user + workspaces, with auth redirect. */
export function useSession(workspaceId: string) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState('');

  useEffect(() => {
    api
      .get<Schemas['Me']>('/api/auth/me')
      .then((me) => {
        setWorkspaces(me.workspaces);
        setEmail(me.user.email);
        setUserId(me.user.id);
        setEmailVerified(me.user.emailVerified);
      })
      .catch((err) => {
        if (err instanceof ApiRequestError && err.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        }
      });
  }, [router, workspaceId]);

  const role = workspaces.find((w) => w.id === workspaceId)?.role ?? 'MEMBER';
  return { workspaces, email, userId, role, setWorkspaces };
}
