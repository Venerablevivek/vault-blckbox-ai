'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeySquare, Trash2 } from 'lucide-react';
import { api, ApiRequestError, formatDate, timeAgo, type Schemas } from '@/lib/api';
import { useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

type ApiToken = Schemas['ApiToken'];

/** Personal API tokens: made, listed and revoked here; used as "Authorization: Bearer <token>". */
export function ApiTokens() {
  const dialogs = useDialogs();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [expiry, setExpiry] = useState<string>('90');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens((await api.get<{ tokens: ApiToken[] }>('/api/auth/tokens')).tokens);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your tokens.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<{ token: ApiToken & { secret: string } }>('/api/auth/tokens', {
        name,
        scopes: access === 'write' ? ['read', 'write'] : ['read'],
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      });
      setSecret(result.token.secret);
      setCopied(false);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the token.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: ApiToken) {
    const ok = await dialogs.confirm({
      title: `Revoke “${token.name}”?`,
      body: 'Anything using it stops working immediately.',
      confirmLabel: 'Revoke token',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/auth/tokens/${token.id}`);
      toast('Token revoked', 'success');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not revoke the token.');
    }
  }

  return (
    <section className="card overflow-hidden" aria-labelledby="tokens-heading">
      <div className="flex items-start gap-3 p-6 pb-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
          <KeySquare className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 id="tokens-heading" className="text-sm font-semibold">
            API tokens
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            For scripts and integrations: send one as <code className="font-mono">Authorization: Bearer …</code>. A
            token can do what your account can (read-only tokens only read). Changing your password revokes them all.
          </p>
        </div>
      </div>

      <div className="space-y-4 px-6 pb-6">
        {error ? <ErrorNote message={error} /> : null}

        {secret ? (
          <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4" role="status">
            <p className="text-sm font-medium text-brand-900">
              Copy your new token now. It won&rsquo;t be shown again.
            </p>
            <p
              className="mt-2 break-all rounded-lg border border-brand-200 bg-surface px-3 py-2 font-mono text-xs"
              data-testid="token-secret"
            >
              {secret}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                className="btn-primary btn-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(secret);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}{' '}
                {copied ? 'Copied' : 'Copy token'}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setSecret(null)}>
                Done
              </button>
            </div>
          </div>
        ) : null}

        {tokens && tokens.length > 0 ? (
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Your API tokens">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {token.name}{' '}
                    <span className={token.scopes.includes('write') ? 'chip-warn ml-1' : 'chip ml-1'}>
                      {token.scopes.includes('write') ? 'read & write' : 'read only'}
                    </span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    <span className="font-mono">{token.prefix}…</span> · created {formatDate(token.createdAt)} ·{' '}
                    {token.lastUsedAt ? `last used ${timeAgo(token.lastUsedAt)}` : 'never used'} ·{' '}
                    {token.expiresAt ? `expires ${formatDate(token.expiresAt)}` : 'never expires'}
                  </p>
                </div>
                <button className="btn-ghost btn-sm hover:text-danger" onClick={() => void revoke(token)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : tokens ? (
          <p className="text-sm text-ink-muted">You have no API tokens.</p>
        ) : null}

        <form onSubmit={create} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="token-name">
              New token name
            </label>
            <input
              id="token-name"
              className="input"
              placeholder="e.g. nightly backup"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="token-access">
              Access
            </label>
            <select
              id="token-access"
              className="input"
              value={access}
              onChange={(e) => setAccess(e.target.value as 'read' | 'write')}
            >
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="token-expiry">
              Expires
            </label>
            <select id="token-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
          </div>
          <button type="submit" className="btn-primary h-10" disabled={creating || name.trim().length === 0}>
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </form>
      </div>
    </section>
  );
}
