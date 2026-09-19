'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiRequestError, safeNextPath } from '@/lib/api';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      router.replace(safeNextPath(next));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  function fillDemo(demoEmail: string) {
    setEmail(demoEmail);
    setPassword('password123');
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <h1 className="text-[26px] font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1.5 text-sm text-ink-muted">Store, organise and share your documents.</p>
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
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="password">
              Password
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-brand-600 hover:underline">
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="input"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary h-10 w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-muted">
        No account?{' '}
        <Link href="/register" className="font-medium text-brand-600 hover:underline">
          Create one
        </Link>
      </p>

      {/* Seeded by the API on first boot — see the README. One click fills the form so a
          reviewer never has to retype credentials. */}
      <div className="card mt-6 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Demo accounts</p>
        <div className="mt-2.5 space-y-1.5">
          {[
            { email: 'alice@example.com', note: 'owns two workspaces' },
            { email: 'bob@example.com', note: 'member of Marketing' },
          ].map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => fillDemo(account.email)}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-sunken"
            >
              <span className="font-mono text-xs">{account.email}</span>
              <span className="text-[11px] text-ink-subtle">{account.note}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 px-2.5 text-[11px] text-ink-subtle">
          Password for both: <span className="font-mono">password123</span>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <PublicShell
      action={
        <Link href="/register" className="btn-secondary btn-sm">
          Create account
        </Link>
      }
    >
      <Suspense fallback={<div className="text-sm text-ink-muted">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </PublicShell>
  );
}
