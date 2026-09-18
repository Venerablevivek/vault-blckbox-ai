'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';

/**
 * Confirms an email address from the emailed link. The token arrives in the URL fragment, which
 * browsers never send to a server, and is removed from the address bar once read.
 */
export default function VerifyEmailPage() {
  const [state, setState] = useState<'working' | 'done' | 'invalid' | 'error'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState('invalid');
      return;
    }
    api
      .post('/api/auth/email/verify', { token })
      .then(() => setState('done'))
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 410) setState('invalid');
        else {
          setState('error');
          setMessage(err instanceof ApiRequestError ? err.message : 'Something went wrong.');
        }
      });
  }, []);

  return (
    <PublicShell>
      <div className="card w-full max-w-sm p-6 text-center" role="status">
        {state === 'working' ? <p className="text-sm text-ink-muted">Confirming your email address…</p> : null}
        {state === 'done' ? (
          <>
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-ok-soft text-ok">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </span>
            <h1 className="mt-4 text-lg font-semibold">Email address confirmed</h1>
            <p className="mt-1.5 text-sm text-ink-muted">You can now share documents and invite people.</p>
            <Link href="/" className="btn-primary mt-5 w-full">
              Continue to Vault
            </Link>
          </>
        ) : null}
        {state === 'invalid' ? (
          <>
            <h1 className="text-lg font-semibold">This link can&rsquo;t be used</h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              It has already been used, has expired, or was copied incompletely. Sign in and send a new one from the
              banner at the top of the page.
            </p>
            <Link href="/" className="btn-secondary mt-5 w-full">
              Go to Vault
            </Link>
          </>
        ) : null}
        {state === 'error' ? <p className="text-sm text-danger">{message}</p> : null}
      </div>
    </PublicShell>
  );
}
