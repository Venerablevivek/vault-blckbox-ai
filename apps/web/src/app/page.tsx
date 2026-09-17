'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderPlus } from 'lucide-react';
import { api, ApiRequestError, type Workspace } from '@/lib/api';
import { Brand } from '@/components/brand';
import { PublicShell } from '@/components/site-chrome';
import { ErrorNote } from '@/components/ui';

/**
 * Entry point: send the user to their first workspace, or to sign in. Someone who has left or
 * deleted every workspace they had gets a way to create a new one instead of a dead end.
 */
export default function HomePage() {
  const router = useRouter();
  const [empty, setEmpty] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ workspaces: Workspace[] }>('/api/auth/me')
      .then(({ workspaces }) => {
        if (workspaces[0]) router.replace(`/workspaces/${workspaces[0].id}`);
        else setEmpty(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ workspace: { id: string } }>('/api/workspaces', { name: name.trim() });
      router.replace(`/workspaces/${result.workspace.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the workspace.');
      setBusy(false);
    }
  }

  if (!empty) {
    return (
      <div className="aurora flex min-h-screen flex-col items-center justify-center gap-4">
        <Brand />
        <p className="text-sm text-ink-muted">Loading your workspace…</p>
      </div>
    );
  }

  return (
    <PublicShell>
      <div className="w-full max-w-sm">
        <div className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <FolderPlus className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-4 text-[26px] font-semibold tracking-tight">Create a workspace</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            You&rsquo;re not in any workspace right now. Start a new one to upload and share documents.
          </p>
        </div>
        <form onSubmit={create} className="card mt-7 space-y-4 p-6">
          {error ? <ErrorNote message={error} /> : null}
          <div>
            <label className="label" htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              id="workspace-name"
              className="input"
              required
              maxLength={120}
              placeholder="e.g. Marketing"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary h-10 w-full" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </div>
    </PublicShell>
  );
}
