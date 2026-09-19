import Link from 'next/link';
import { Brand } from './brand';

/** Header for the signed-out pages: sign-in, register, invitation landing. */
export function SiteHeader({ action }: { action?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/80 bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Brand />
        {action}
      </div>
    </header>
  );
}

const LOCAL_TOOLS = [
  { label: 'API status', href: 'http://localhost:4000/health' },
  { label: 'Mail inbox', href: 'http://localhost:8025' },
  { label: 'Object storage', href: 'http://localhost:9001' },
];

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 opacity-60" fill="none" aria-hidden="true">
      <path
        d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Footer. Carries the things a reviewer running this locally actually wants: where the API,
 * the mail inbox (Mailpit catches every email the app sends) and the object-store console live.
 * `compact` is the single-row version used inside the signed-in app.
 */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  const year = new Date().getFullYear();
  const tools = (
    <nav aria-label="Local services" className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {LOCAL_TOOLS.map((tool) => (
        <a
          key={tool.href}
          className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          href={tool.href}
          target="_blank"
          rel="noreferrer"
        >
          {tool.label}
          <ExternalIcon />
        </a>
      ))}
    </nav>
  );
  const credit = (
    <p>
      © {year} Vault · Developed by <span className="font-medium text-ink">Vivek Chaudhary</span>
    </p>
  );

  if (compact) {
    return (
      <footer className="border-t border-line/80 px-6 py-4 text-xs text-ink-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {credit}
          {tools}
        </div>
      </footer>
    );
  }

  return (
    <footer className="border-t border-line/80 bg-surface/60 backdrop-blur">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm space-y-2">
            <Brand />
            <p className="text-xs leading-relaxed text-ink-muted">
              Documents, workspaces and revocable share links — every link can expire, be revoked, and tells you when it
              is opened.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 text-xs">
            <div className="space-y-2">
              <p className="font-semibold uppercase tracking-wider text-ink-subtle">Vault</p>
              <ul className="space-y-1.5 text-ink-muted">
                <li>
                  <Link className="transition-colors hover:text-ink" href="/">
                    Home
                  </Link>
                </li>
                <li>
                  <Link className="transition-colors hover:text-ink" href="/login">
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link className="transition-colors hover:text-ink" href="/register">
                    Create account
                  </Link>
                </li>
              </ul>
            </div>
            <div className="space-y-2">
              <p className="font-semibold uppercase tracking-wider text-ink-subtle">Local services</p>
              <ul className="space-y-1.5 text-ink-muted">
                {LOCAL_TOOLS.map((tool) => (
                  <li key={tool.href}>
                    <a
                      className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                      href={tool.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tool.label}
                      <ExternalIcon />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="mt-8 border-t border-line/80 pt-5 text-xs text-ink-subtle">{credit}</div>
      </div>
    </footer>
  );
}

/** Shell for signed-out pages: header, centred content, footer. */
export function PublicShell({
  children,
  action,
  bare = false,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  bare?: boolean;
}) {
  return (
    <div className="aurora flex min-h-screen flex-col">
      {bare ? null : <SiteHeader action={action} />}
      <main className="flex flex-1 items-center justify-center px-6 py-14">{children}</main>
      <SiteFooter />
    </div>
  );
}
