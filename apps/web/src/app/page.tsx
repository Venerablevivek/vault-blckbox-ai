'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, type Workspace } from '@/lib/api';
import { Brand } from '@/components/brand';

/** Entry point: send the user to their first workspace, or to sign in. */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    api
      .get<{ workspaces: Workspace[] }>('/api/auth/me')
      .then(({ workspaces }) => {
        router.replace(workspaces[0] ? `/workspaces/${workspaces[0].id}` : '/login');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="aurora flex min-h-screen flex-col items-center justify-center gap-4">
      <Brand />
      <p className="text-sm text-ink-muted">Loading your workspace…</p>
    </div>
  );
}
