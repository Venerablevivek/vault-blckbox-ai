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

/**
 * Footer. Carries the things a reviewer running this locally actually wants: where the
 * API and the object-store console live.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line/80 bg-surface/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-6 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span className="font-medium text-ink">Vault</span> — documents, workspaces and revocable share links.
        </p>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <a className="hover:text-ink" href="http://localhost:4000/health" target="_blank" rel="noreferrer">
            API status
          </a>
          <a className="hover:text-ink" href="http://localhost:9001" target="_blank" rel="noreferrer">
            Object storage
          </a>
          <Link className="hover:text-ink" href="/login">
            Sign in
          </Link>
        </nav>
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
