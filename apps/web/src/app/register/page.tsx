'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const inviteToken = params.get('invite');
  const invitedEmail = params.get('email');

  const [email, setEmail] = useState(invitedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (invitedEmail) setEmail(invitedEmail);
  }, [invitedEmail]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The invite token travels with registration so the account is created and the
      // workspace joined in one server-side transaction.
      await api.post('/api/auth/register', {
        email,
        password,
        ...(inviteToken ? { inviteToken } : {}),
      });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <h1 className="text-[26px] font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {inviteToken
            ? 'You have been invited to a workspace — create an account to join it.'
            : 'A personal workspace is set up for you automatically.'}
        </p>
      </div>

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
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // The invitation is bound to this address, so it cannot be changed here.
            readOnly={Boolean(invitedEmail)}
          />
          {invitedEmail ? (
            <p className="mt-1.5 text-xs text-ink-subtle">This invitation is tied to this address.</p>
          ) : null}
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="input"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <PublicShell
      action={
        <Link href="/login" className="btn-secondary btn-sm">
          Sign in
        </Link>
      }
    >
      <Suspense fallback={<div className="text-sm text-ink-muted">Loading…</div>}>
        <RegisterForm />
      </Suspense>
    </PublicShell>
  );
}
