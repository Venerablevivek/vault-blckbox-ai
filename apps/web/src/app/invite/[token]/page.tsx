'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError, formatDate, type Schemas } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

type Preview = Schemas['InvitationPreview'];

/**
 * Invitation landing page. The recipient may or may not have an account, so this offers
 * both paths, and acceptance happens only once they are authenticated.
 */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setPreview(await api.get<Preview>(`/api/invitations/${token}`));
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'This invitation is not valid.');
        setLoading(false);
        return;
      }
      try {
        await api.get('/api/auth/me');
        setSignedIn(true);
      } catch {
        setSignedIn(false);
      }
      setLoading(false);
    })();
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ workspaceId: string }>(`/api/invitations/${token}/accept`);
      router.replace(`/workspaces/${result.workspaceId}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not accept the invitation.');
      setBusy(false);
    }
  }

  return (
    <PublicShell action={<Link href="/login" className="btn-secondary btn-sm">Sign in</Link>}>
      <div className="card w-full max-w-md p-7">
        {loading ? (
          <p className="text-sm text-ink-muted">Loading invitation…</p>
        ) : !preview ? (
          <>
            <h1 className="text-lg font-semibold">Invitation unavailable</h1>
            <p className="mt-2 text-sm text-ink-muted">{error}</p>
            <Link href="/login" className="btn-secondary mt-5 w-full">Go to sign in</Link>
          </>
        ) : (
          <>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
                <path d="M4 7l8 5 8-5M4 7v10h16V7H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </div>

            <h1 className="mt-4 text-lg font-semibold">
              Join “{preview.workspaceName}”
            </h1>
            <p className="mt-2 text-sm text-ink-muted">
              This invitation was sent to{' '}
              <span className="font-medium text-ink">{preview.email}</span>. You will join as{' '}
              {preview.role.toLowerCase()}.
            </p>
            <p className="mt-1 text-xs text-ink-subtle">
              Expires {formatDate(preview.expiresAt)}
            </p>

            {error ? <div className="mt-4"><ErrorNote message={error} /></div> : null}

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              {signedIn ? (
                <button className="btn-primary h-10 flex-1" onClick={() => void accept()} disabled={busy}>
                  {busy ? 'Joining…' : 'Accept invitation'}
                </button>
              ) : (
                <>
                  <a
                    className="btn-primary h-10 flex-1"
                    href={`/register?invite=${token}&email=${encodeURIComponent(preview.email)}`}
                  >
                    Create account
                  </a>
                  <a className="btn-secondary h-10 flex-1" href={`/login?next=/invite/${token}`}>
                    I have an account
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </PublicShell>
  );
}
