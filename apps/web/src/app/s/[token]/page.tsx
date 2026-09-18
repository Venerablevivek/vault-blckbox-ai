import { headers } from 'next/headers';
import { DeadLink, expiryLabel, Frame, kindOf } from '@/components/share-page';
import { ShareEmailForm } from '@/components/share-email-form';
import { SharePasswordForm } from '@/components/share-password-form';
import { ViewBeacon } from '@/components/view-beacon';
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

type ShareMeta =
  | { locked: true; requiresEmail: boolean; requiresPassword: boolean; expiresAt: string | null }
  | {
      locked: false;
      passwordProtected: boolean;
      restricted: boolean;
      viewerEmail: string | null;
      allowDownload: boolean;
      previewable: boolean;
      watermark: string | null;
      filename: string;
      mimeType: string;
      size: number;
      expiresAt: string | null;
      downloadsRemaining: number | null;
    };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // This fetch runs on the web server, so without help the API would see every visitor as
  // the web container and apply one shared rate limit to all of them. server.mjs has already
  // set X-Forwarded-For to the visitor's socket address; pass it on (the API trusts it only
  // from this container).
  //
  // The browser's cookies are forwarded too: a password-protected link is unlocked by an
  // HttpOnly cookie the API set, and the API needs to see it to reveal the document.
  const incoming = await headers();
  const clientIp = incoming.get('x-forwarded-for') ?? '';
  const cookie = incoming.get('cookie') ?? '';
  const response = await fetch(`${API}/api/shares/${encodeURIComponent(token)}`, {
    cache: 'no-store',
    headers: { ...(clientIp ? { 'x-forwarded-for': clientIp } : {}), ...(cookie ? { cookie } : {}) },
  });

  if (!response.ok) {
    // 410 means the link was real but is revoked, expired, or its document was deleted.
    // Saying so — rather than showing a 404 — tells the recipient it is worth asking the
    // sender for a new one.
    const gone = response.status === 410;
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const usedUp = gone && /download limit/i.test(body.error?.message ?? '');
    return (
      <Frame>
        {/* Attempts on a dead link are recorded too — useful signal for the sender. */}
        {gone ? <ViewBeacon token={token} /> : null}
        <DeadLink gone={gone} usedUp={usedUp} />
      </Frame>
    );
  }

  const meta = (await response.json()) as ShareMeta;

  if (meta.locked && meta.requiresEmail) {
    // Only named people may open this link. As with a password, nothing about the document is
    // shown until they have proved their address.
    return (
      <Frame>
        <div className="panel overflow-hidden">
          <div className="bg-gradient-to-br from-brand-600 to-brand-700 px-8 py-9 text-center">
            <span
              className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/25"
              aria-hidden
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none">
                <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            <h1 className="mt-4 text-lg font-semibold text-white">This file was shared with specific people</h1>
            <p className="mt-1 text-sm text-brand-100">Confirm your email address to open it.</p>
          </div>
          <ShareEmailForm token={token} />
          <p className="border-t border-line px-8 py-4 text-center text-[11px] leading-relaxed text-ink-subtle">
            {expiryLabel(meta.expiresAt)}. The sender can see which address opened the file.
          </p>
        </div>
      </Frame>
    );
  }

  if (meta.locked) {
    // Nothing about the document is known yet: the API withholds the name, size and type
    // until the password is entered. No view is counted for a locked page either.
    return (
      <Frame>
        <div className="panel overflow-hidden">
          <div className="bg-gradient-to-br from-brand-600 to-brand-700 px-8 py-9 text-center">
            <span
              className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/25"
              aria-hidden
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none">
                <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            <h1 className="mt-4 text-lg font-semibold text-white">This file is password protected</h1>
            <p className="mt-1 text-sm text-brand-100">Enter the password the sender gave you.</p>
          </div>
          <SharePasswordForm token={token} />
          <p className="border-t border-line px-8 py-4 text-center text-[11px] leading-relaxed text-ink-subtle">
            {expiryLabel(meta.expiresAt)}. Wrong attempts are recorded and limited.
          </p>
        </div>
      </Frame>
    );
  }

  const extension = (meta.filename.split('.').pop() ?? '?').slice(0, 4).toUpperCase();
  const content = `/api/shares/${encodeURIComponent(token)}/content`;
  const isImage = meta.mimeType.startsWith('image/');

  const details = (
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
        {meta.allowDownload ? (
          <a className="btn-primary h-11 w-full text-[15px]" href={`/api/shares/${encodeURIComponent(token)}/download`}>
            Download
          </a>
        ) : (
          <p className="rounded-lg bg-slate-50 px-4 py-3 text-center text-sm text-ink-muted">
            <span className="font-medium text-ink">View only.</span> The sender turned off downloading. What you see is
            marked with your {meta.viewerEmail ? 'address' : 'viewer ID'} and the time.
          </p>
        )}

        <p className="mt-4 text-center text-xs text-ink-muted">
          {expiryLabel(meta.expiresAt)}
          {meta.allowDownload && meta.downloadsRemaining !== null
            ? ` · ${meta.downloadsRemaining === 1 ? 'Can be downloaded once more' : `${meta.downloadsRemaining} downloads left`}`
            : ''}
        </p>
        {meta.viewerEmail ? (
          <p className="mt-2 text-center text-xs text-ink-muted">
            Opened as <span className="font-medium text-ink">{meta.viewerEmail}</span>
          </p>
        ) : null}

        {/* The visitor is not our user and never agreed to be tracked, so we say plainly
            what is recorded. The feature is link hygiene, not surveillance. */}
        <p className="mt-5 border-t border-line pt-4 text-center text-[11px] leading-relaxed text-ink-subtle">
          Shared securely. The sender can see when this link is opened, and can revoke it at any time.
        </p>
      </div>
    </div>
  );

  if (!meta.previewable) {
    return (
      <Frame>
        <ViewBeacon token={token} />
        {details}
      </Frame>
    );
  }

  return (
    <Frame wide>
      <ViewBeacon token={token} />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <section
          aria-label={`Preview of ${meta.filename}`}
          className="panel relative flex min-h-[240px] items-center justify-center overflow-hidden bg-slate-50"
        >
          {isImage ? (
            // Served from the API, never cached; the overlay repeats the watermark over the picture.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={content}
              alt={meta.filename}
              className="mx-auto block max-h-[75vh] w-auto select-none"
              draggable={false}
            />
          ) : (
            <iframe
              src={meta.allowDownload ? content : `${content}#toolbar=0&navpanes=0`}
              title={meta.filename}
              className="block h-[75vh] w-full bg-white"
            />
          )}
          {isImage && meta.watermark ? (
            <div
              aria-hidden
              data-testid="watermark"
              className="pointer-events-none absolute inset-0 flex select-none flex-col justify-around overflow-hidden"
            >
              {[0, 1, 2, 3].map((row) => (
                <p key={row} className="-rotate-12 whitespace-nowrap text-center text-sm font-medium text-slate-900/25">
                  {meta.watermark} · {meta.watermark}
                </p>
              ))}
            </div>
          ) : null}
        </section>
        {details}
      </div>
    </Frame>
  );
}
