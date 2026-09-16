import { Brand } from '@/components/brand';
import { SiteFooter } from '@/components/site-chrome';
import { formatBytes } from '@/lib/api';

/**
 * The public share page — the only thing a recipient outside the team ever sees.
 *
 * Deliberately bare: no navigation, no sign-in prompt, no product marketing. Rendered on
 * the server so a dead link shows its real state immediately rather than flashing a
 * loading state first.
 */
export const dynamic = 'force-dynamic';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

interface ShareMeta {
  filename: string;
  mimeType: string;
  size: number;
  expiresAt: string | null;
}

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'This link does not expire';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'This link has expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}

function kindOf(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'PDF document';
  if (/sheet|excel|csv/.test(mimeType)) return 'Spreadsheet';
  if (/word|document/.test(mimeType)) return 'Document';
  if (/presentation|powerpoint/.test(mimeType)) return 'Presentation';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('text/')) return 'Text file';
  return 'File';
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="aurora flex min-h-screen flex-col">
      <header className="flex h-16 items-center justify-center px-6">
        <Brand href="#" />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-[420px]">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const response = await fetch(`${API}/api/shares/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    // 410 means the link was real but is revoked, expired, or its document was deleted.
    // Saying so — rather than showing a 404 — tells the recipient it is worth asking the
    // sender for a new one.
    const gone = response.status === 410;
    return (
      <Frame>
        <div className="panel p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
              <path
                d="M10 13a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 1 0-5.66-5.66l-1 1M14 11a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 1 0 5.66 5.66l1-1"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
              />
              <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="mt-5 text-base font-semibold">
            {gone ? 'This link is no longer available' : 'Link not found'}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {gone
              ? 'It may have expired or been revoked by the sender. Ask them for a new one.'
              : 'Please double-check the link you were given.'}
          </p>
        </div>
      </Frame>
    );
  }

  const meta = (await response.json()) as ShareMeta;
  const extension = (meta.filename.split('.').pop() ?? '?').slice(0, 4).toUpperCase();

  return (
    <Frame>
      <div className="panel overflow-hidden">
        <div className="bg-gradient-to-br from-brand-600 to-brand-700 px-8 py-9 text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-sm font-bold tracking-tight text-white ring-1 ring-white/25 backdrop-blur">
            {extension}
          </span>
          <h1 className="mt-4 break-words text-lg font-semibold text-white">{meta.filename}</h1>
          <p className="mt-1 text-sm text-brand-100">
            {formatBytes(meta.size)} · {kindOf(meta.mimeType)}
          </p>
        </div>

        <div className="px-8 py-7">
          <a
            className="btn-primary h-11 w-full text-[15px]"
            href={`/api/shares/${encodeURIComponent(token)}/download`}
          >
            Download
          </a>

          <p className="mt-4 text-center text-xs text-ink-muted">{expiryLabel(meta.expiresAt)}</p>

          {/* The visitor is not our user and never agreed to be tracked, so we say plainly
              what is recorded. The feature is link hygiene, not surveillance. */}
          <p className="mt-5 border-t border-line pt-4 text-center text-[11px] leading-relaxed text-ink-subtle">
            Shared securely. The sender can see when this link is opened, and can revoke it at
            any time.
          </p>
        </div>
      </div>
    </Frame>
  );
}
