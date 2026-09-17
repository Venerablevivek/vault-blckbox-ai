'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

/**
 * Sets a new password from an emailed link. The token arrives in the URL fragment
 * (#token=…), which browsers never send to a server, and is removed from the address bar
 * as soon as it is read so it doesn't linger in history.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    // '' (not null) marks "no token in the link", so the page can say so.
    setToken(value ?? '');
    if (value) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password/reset', { token, password });
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 410) setExpired(true);
      else setError(err instanceof ApiRequestError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <PublicShell action={<Link href="/login" className="btn-secondary btn-sm">Sign in</Link>}>
      <div className="w-full max-w-sm">
        <div className="text-center">
          <h1 className="text-[26px] font-semibold tracking-tight">Choose a new password</h1>
          <p className="mt-1.5 text-sm text-ink-muted">You&rsquo;ll be signed out everywhere else.</p>
        </div>

        {expired || token === '' ? (
          <div className="card mt-7 p-6 text-center">
            <p className="text-sm font-semibold">This link can&rsquo;t be used</p>
            <p className="mt-1.5 text-sm text-ink-muted">It has already been used, has expired, or was copied incompletely.</p>
            <Link href="/forgot-password" className="btn-primary mt-5 w-full">Request a new link</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="card mt-7 space-y-4 p-6">
            {error ? <ErrorNote message={error} /> : null}
            <div>
              <label className="label" htmlFor="password">New password</label>
              <input
                id="password" type="password" required minLength={8} maxLength={200} autoComplete="new-password"
                className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
              />
              <p className="mt-1 text-xs text-ink-subtle">At least 8 characters. A passphrase is best.</p>
            </div>
            <div>
              <label className="label" htmlFor="confirm">Confirm new password</label>
              <input
                id="confirm" type="password" required minLength={8} maxLength={200} autoComplete="new-password"
                className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary h-10 w-full" disabled={busy || !token}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
