'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

/**
 * Asks for a reset link. The confirmation is the same whether or not the address has an
 * account, so this page can't be used to find out who is registered.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 429
          ? 'Too many requests. Please wait a while before trying again.'
          : err instanceof ApiRequestError
            ? err.message
            : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell
      action={
        <Link href="/login" className="btn-secondary btn-sm">
          Sign in
        </Link>
      }
    >
      <div className="w-full max-w-sm">
        <div className="text-center">
          <h1 className="text-[26px] font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1.5 text-sm text-ink-muted">We&rsquo;ll email you a link to choose a new one.</p>
        </div>

        {sent ? (
          <div className="card mt-7 p-6 text-center" role="status">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-ok-soft text-ok">
              <MailCheck className="h-5 w-5" aria-hidden />
            </span>
            <p className="mt-4 text-sm font-semibold">Check your email</p>
            <p className="mt-1.5 text-sm text-ink-muted">
              If an account exists for <span className="font-medium text-ink">{email}</span>, a reset link is on its
              way. It works once and expires in an hour.
            </p>
            <Link href="/login" className="btn-secondary mt-5 w-full">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="card mt-7 space-y-4 p-6">
            {error ? <ErrorNote message={error} /> : null}
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                className="input"
                autoFocus
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary h-10 w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-5 text-center text-sm text-ink-muted">
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </PublicShell>
  );
}
