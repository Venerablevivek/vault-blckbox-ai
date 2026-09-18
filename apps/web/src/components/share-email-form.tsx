'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, ShieldCheck } from 'lucide-react';

/**
 * Opens a link restricted to named people: the recipient gives their address, receives a
 * one-time code there, and enters it. The API answers the first step the same way whether or not
 * the address is on the link, so this form never says which addresses are.
 *
 * On success the API sets an HttpOnly cookie for this link and the page re-renders on the server.
 */
export function ShareEmailForm({ token }: { token: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/shares/${encodeURIComponent(token)}`;

  async function post(path: string, body: object) {
    const response = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: { code?: string; message?: string };
    };
    return { response, payload };
  }

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await post('code', { email });
      if (response.status === 202) {
        setStep('code');
        setCode('');
        setNotice(payload.message ?? 'If that address can open this link, a code is on its way.');
      } else if (response.status === 410) {
        router.refresh();
      } else if (response.status === 429) {
        setError('Too many requests. Please wait a few minutes and try again.');
      } else {
        setError(payload.error?.message ?? 'Enter a valid email address.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await post('verify', { email, code });
      if (response.ok) {
        router.refresh();
        return;
      }
      if (response.status === 410) router.refresh();
      else if (response.status === 429) setError('Too many attempts. Please wait a few minutes and try again.');
      else setError(payload.error?.message ?? 'That code is not correct.');
      setCode('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const errorNote = error ? (
    <p id="share-email-error" role="alert" className="mt-2 text-sm text-danger">
      {error}
    </p>
  ) : null;

  if (step === 'email') {
    return (
      <form onSubmit={sendCode} className="px-8 py-7" noValidate>
        <label htmlFor="share-email" className="label">
          Your email address
        </label>
        <input
          id="share-email"
          type="email"
          className="input h-11"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'share-email-error' : undefined}
          required
        />
        {errorNote}
        <button
          type="submit"
          className="btn-primary mt-4 h-11 w-full text-[15px]"
          disabled={busy || !email.includes('@')}
        >
          <Mail className="h-4 w-4" aria-hidden /> {busy ? 'Sending…' : 'Email me a code'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="px-8 py-7" noValidate>
      {notice ? (
        <p className="mb-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800" role="status">
          {notice}
        </p>
      ) : null}
      <label htmlFor="share-code" className="label">
        6-digit code sent to {email}
      </label>
      <input
        id="share-code"
        className="input h-11 text-center text-lg tracking-[0.4em]"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'share-email-error' : undefined}
        required
      />
      {errorNote}
      <button type="submit" className="btn-primary mt-4 h-11 w-full text-[15px]" disabled={busy || code.length !== 6}>
        <ShieldCheck className="h-4 w-4" aria-hidden /> {busy ? 'Checking…' : 'Open the file'}
      </button>
      <div className="mt-3 flex justify-between text-xs">
        <button
          type="button"
          className="text-brand-600 hover:underline"
          onClick={() => void sendCode()}
          disabled={busy}
        >
          Send a new code
        </button>
        <button
          type="button"
          className="text-ink-muted hover:underline"
          onClick={() => {
            setStep('email');
            setError(null);
            setNotice(null);
          }}
        >
          Use a different address
        </button>
      </div>
    </form>
  );
}
