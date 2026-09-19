import { Inbox } from 'lucide-react';
import { headers } from 'next/headers';
import { FileRequestForm } from '@/components/file-request-form';
import { Frame } from '@/components/share-page';
import type { Schemas } from '@/lib/api';

/**
 * The public page of a file request: someone outside the workspace sends files into it, with
 * no account. Rendered on the server so a dead link gets a real 404/410 page; the form itself
 * is a small client component.
 */
export const dynamic = 'force-dynamic';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

function expiresLabel(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Open for ${days} more day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `Open for ${hours} more hour${hours === 1 ? '' : 's'}`;
}

export default async function FileRequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const clientIp = (await headers()).get('x-forwarded-for') ?? '';
  const response = await fetch(`${API}/api/requests/${encodeURIComponent(token)}`, {
    cache: 'no-store',
    headers: clientIp ? { 'x-forwarded-for': clientIp } : {},
  }).catch(() => null);

  if (!response?.ok) {
    const gone = response?.status === 410;
    return (
      <Frame>
        <div className="panel p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-surface-muted text-ink-subtle">
            <Inbox className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="mt-5 text-base font-semibold">
            {gone ? 'This file request is closed' : response ? 'File request not found' : 'Something went wrong'}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {gone
              ? 'It has expired, received all the files it asked for, or was closed. Ask the person who sent it for a new link.'
              : response
                ? 'Please double-check the link you were given.'
                : 'Please try again in a moment.'}
          </p>
        </div>
      </Frame>
    );
  }

  const { request } = (await response.json()) as { request: Schemas['PublicFileRequest'] };
  return (
    <Frame wide>
      <div className="grid gap-6 md:grid-cols-[1fr_1.3fr]">
        <section className="panel overflow-hidden">
          <div className="bg-gradient-to-br from-brand-600 to-brand-700 px-6 py-7 text-white dark:from-indigo-700 dark:to-indigo-900">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15">
              <Inbox className="h-5 w-5" aria-hidden />
            </div>
            <p className="mt-4 text-xs font-medium uppercase tracking-wider text-white/75">File request</p>
            <h1 className="mt-1 text-xl font-semibold leading-snug">{request.title}</h1>
          </div>
          <div className="space-y-4 px-6 py-5 text-sm">
            {request.message ? <p className="whitespace-pre-wrap text-ink">{request.message}</p> : null}
            <dl className="space-y-2 text-ink-muted">
              <div>
                <dt className="text-xs uppercase tracking-wider text-ink-subtle">Requested by</dt>
                <dd className="text-ink">{request.requestedBy}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-ink-subtle">Workspace</dt>
                <dd className="text-ink">{request.workspaceName}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-ink-subtle">Status</dt>
                <dd className="text-ink">
                  {expiresLabel(request.expiresAt)}
                  {request.remainingFiles !== null
                    ? ` · ${request.remainingFiles} file${request.remainingFiles === 1 ? '' : 's'} left`
                    : ''}
                </dd>
              </div>
            </dl>
            <p className="border-t border-line pt-4 text-xs text-ink-subtle">
              You can send files but not see anything already in the workspace. Files are checked for type and malware
              before anyone opens them.
            </p>
          </div>
        </section>
        <FileRequestForm token={token} maxFileBytes={request.maxFileBytes} remainingFiles={request.remainingFiles} />
      </div>
    </Frame>
  );
}
