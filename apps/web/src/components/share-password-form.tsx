'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';

/**
 * Unlocks a password-protected share link.
 *
 * On success the API sets an HttpOnly cookie scoped to this one link, valid for an hour, and
 * the page re-renders on the server with the document shown. The password itself never
 * touches client-side storage.
 */
export function SharePasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(token)}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      if (response.status === 429) {
        setError(payload.error?.code === 'LINK_LOCKED'
          ? 'Too many wrong passwords for this link. Try again later, or ask the sender.'
          : 'Too many attempts. Please wait a moment and try again.');
      } else if (response.status === 410) {
        router.refresh();
      } else {
        setError(payload.error?.message ?? 'That password is not correct.');
      }
      setPassword('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="px-8 py-7" noValidate>
      <label htmlFor="share-password" className="label">
        Password
      </label>
      <input
        id="share-password"
        type="password"
        className="input h-11"
        autoComplete="off"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'share-password-error' : undefined}
        required
      />
      {error ? (
        <p id="share-password-error" role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary mt-4 h-11 w-full text-[15px]" disabled={busy || password.length === 0}>
        <KeyRound className="h-4 w-4" aria-hidden /> {busy ? 'Checking…' : 'Unlock'}
      </button>
    </form>
  );
}
