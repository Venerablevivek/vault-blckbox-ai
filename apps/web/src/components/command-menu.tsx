'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowRight,
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { api, type DocumentDto, type Workspace } from '@/lib/api';
import { useDialogBehaviour, useMounted } from './dialog';
import { setTheme } from './theme';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: LucideIcon;
  run: () => void;
}

/** Everything the menu can do that doesn't need the server: pages, workspaces, theme, sign out. */
function staticCommands(
  workspaceId: string,
  workspaces: Workspace[],
  go: (href: string) => void,
  signOut: () => void,
): Command[] {
  const base = `/workspaces/${workspaceId}`;
  return [
    { id: 'overview', label: 'Overview', group: 'Go to', icon: LayoutDashboard, run: () => go(base) },
    { id: 'documents', label: 'Documents', group: 'Go to', icon: FileText, run: () => go(`${base}/documents`) },
    { id: 'members', label: 'Members', group: 'Go to', icon: Users, run: () => go(`${base}/members`) },
    { id: 'activity', label: 'Activity', group: 'Go to', icon: Activity, run: () => go(`${base}/activity`) },
    { id: 'settings', label: 'Workspace settings', group: 'Go to', icon: Settings, run: () => go(`${base}/settings`) },
    {
      id: 'account',
      label: 'Account and security',
      hint: 'password, sessions, notifications, API tokens',
      group: 'Go to',
      icon: UserCog,
      run: () => go(`${base}/account`),
    },
    ...workspaces
      .filter((w) => w.id !== workspaceId)
      .map((w) => ({
        id: `workspace-${w.id}`,
        label: w.name,
        hint: 'switch workspace',
        group: 'Workspaces',
        icon: FolderOpen,
        run: () => go(`/workspaces/${w.id}`),
      })),
    { id: 'theme-system', label: 'Use the system theme', group: 'Theme', icon: Monitor, run: () => setTheme('system') },
    { id: 'theme-light', label: 'Use the light theme', group: 'Theme', icon: Sun, run: () => setTheme('light') },
    { id: 'theme-dark', label: 'Use the dark theme', group: 'Theme', icon: Moon, run: () => setTheme('dark') },
    { id: 'sign-out', label: 'Sign out', group: 'Account', icon: LogOut, run: signOut },
  ];
}

/** Every word of the query appears somewhere in the label or hint, in any order. */
function matches(command: Command, query: string): boolean {
  const haystack = `${command.label} ${command.hint ?? ''} ${command.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * The command menu (⌘K / Ctrl+K): jump anywhere, switch workspace or theme, or find a document
 * by name or by the words inside it. A combobox: typing filters, arrow keys move, Enter runs.
 */
export function CommandMenu({
  open,
  onClose,
  workspaceId,
  workspaces,
  signOut,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaces: Workspace[];
  signOut: () => void;
}) {
  const router = useRouter();
  const mounted = useMounted();
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<DocumentDto[]>([]);
  useDialogBehaviour(open, onClose, panel, 'input');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setFound([]);
      setActive(0);
    }
  }, [open]);

  // Documents: searched on the server (names and contents), after typing pauses.
  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setFound([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void api
        .get<{ documents: DocumentDto[] }>(
          `/api/workspaces/${workspaceId}/documents?q=${encodeURIComponent(term)}&limit=6`,
        )
        .then((result) => {
          if (!stale) setFound(result.documents);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, open, workspaceId]);

  const commands = useMemo(() => {
    const go = (href: string) => router.push(href);
    const fixed = staticCommands(workspaceId, workspaces, go, signOut).filter((c) => matches(c, query));
    const documents: Command[] = found.map((doc) => ({
      id: `doc-${doc.id}`,
      label: doc.filename,
      hint: doc.matchSnippet ? doc.matchSnippet.replace(/[⟦⟧]/g, '') : undefined,
      group: 'Documents',
      icon: FileText,
      run: () => go(`/workspaces/${workspaceId}/documents?q=${encodeURIComponent(doc.filename)}`),
    }));
    const term = query.trim();
    const searchAll: Command[] =
      term.length > 0
        ? [
            {
              id: 'search-all',
              label: `Search documents for “${term}”`,
              group: 'Documents',
              icon: Search,
              run: () => go(`/workspaces/${workspaceId}/documents?q=${encodeURIComponent(term)}`),
            },
          ]
        : [];
    // Pages and actions that match come first, so typing "activity" + Enter goes there; then
    // documents, then searching everything.
    return [...fixed, ...documents, ...searchAll];
  }, [query, found, workspaceId, workspaces, router, signOut]);

  useEffect(() => setActive(0), [query, found]);

  if (!open || !mounted) return null;

  function run(command: Command | undefined) {
    if (!command) return;
    onClose();
    command.run();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, commands.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(commands[active]);
    }
  }

  const optionId = (i: number) => `${listId}-option-${i}`;
  let lastGroup = '';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-sm" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="panel relative w-full max-w-xl animate-rise overflow-hidden"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
          <input
            className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder="Search documents, pages and actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={commands.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label="Command"
          />
          <kbd className="rounded border border-line-strong px-1.5 text-[10px] text-ink-subtle">Esc</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-2">
          {commands.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-ink-muted">Nothing matches “{query}”.</li>
          ) : (
            commands.map((command, i) => {
              const heading = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              const Icon = command.icon;
              return (
                <li key={command.id} role="presentation">
                  {heading ? (
                    <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                      {heading}
                    </p>
                  ) : null}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(command)}
                    className={`mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${i === active ? 'bg-brand-50 text-ink' : 'text-ink-muted'}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{command.label}</span>
                      {command.hint ? (
                        <span className="block truncate text-xs text-ink-subtle">{command.hint}</span>
                      ) : null}
                    </span>
                    {i === active ? <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
