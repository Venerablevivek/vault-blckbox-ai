import { Brand } from '@/components/brand';
import { SiteFooter } from '@/components/site-chrome';

/** Pieces shared by the public link pages (/s/<token> for a document, /f/<token> for a folder). */

export function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'This link does not expire';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'This link has expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function kindOf(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'PDF document';
  if (/sheet|excel|csv/.test(mimeType)) return 'Spreadsheet';
  if (/word|document/.test(mimeType)) return 'Document';
  if (/presentation|powerpoint/.test(mimeType)) return 'Presentation';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('text/')) return 'Text file';
  return 'File';
}

export function Frame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="aurora flex min-h-screen flex-col">
      <header className="flex h-16 items-center justify-center px-6">
        <Brand href="#" />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-[420px]'}`}>{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

/** A link that is dead (410: revoked, expired, used up) or never existed (404). */
export function DeadLink({ gone, usedUp }: { gone: boolean; usedUp: boolean }) {
  return (
    <div className="panel p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
          <path
            d="M10 13a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 1 0-5.66-5.66l-1 1M14 11a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 1 0 5.66 5.66l1-1"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <h1 className="mt-5 text-base font-semibold">
        {usedUp ? 'This link has already been used' : gone ? 'This link is no longer available' : 'Link not found'}
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        {usedUp
          ? 'It could only be downloaded a limited number of times. Ask the sender for a new one.'
          : gone
            ? 'It may have expired or been revoked by the sender. Ask them for a new one.'
            : 'Please double-check the link you were given.'}
      </p>
    </div>
  );
}
