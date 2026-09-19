'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, HardDrive, LogOut, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { useDialogs } from '@/components/dialog';
import { WebhooksPanel } from '@/components/webhooks-panel';
import { toast } from '@/components/toast';
import { RoleBadge, Shell, StorageMeter, useSession, WorkspaceAvatar } from '@/components/ui';

export default function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);
  const router = useRouter();
  const dialogs = useDialogs();
  const session = useSession(workspaceId);
  const workspace = session.workspaces.find((w) => w.id === workspaceId);
  const isOwner = workspace?.role === 'OWNER';

  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [storage, setStorage] = useState<{ usedBytes: number; quotaBytes: number } | null>(null);

  useEffect(() => {
    api
      .get<{ storage: { usedBytes: number; quotaBytes: number } }>(`/api/workspaces/${workspaceId}/storage`)
      .then((result) => setStorage(result.storage))
      .catch(() => setStorage(null));
  }, [workspaceId]);

  useEffect(() => {
    if (workspace) setName(workspace.name);
  }, [workspace]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/api/workspaces/${workspaceId}`, { name });
      session.setWorkspaces((list) => list.map((w) => (w.id === workspaceId ? { ...w, name } : w)));
      toast('Workspace renamed', 'success');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not rename workspace.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function leave() {
    const ok = await dialogs.confirm({
      title: `Leave “${workspace?.name}”?`,
      body: 'You lose access to its documents immediately, and any share links you created stop working. Documents you uploaded stay in the workspace.',
      confirmLabel: 'Leave workspace',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/workspaces/${workspaceId}/members/${session.userId}`);
      toast('You left the workspace', 'success');
      const other = session.workspaces.find((w) => w.id !== workspaceId);
      router.replace(other ? `/workspaces/${other.id}` : '/');
    } catch (err) {
      // e.g. LAST_OWNER — the message explains what to do instead.
      toast(err instanceof ApiRequestError ? err.message : 'Could not leave workspace.', 'error');
    }
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    const typed = await dialogs.prompt({
      title: `Delete “${workspace.name}”?`,
      body: (
        <>
          Every document, folder, share link and invitation in this workspace is deleted, and everyone in it loses
          access immediately. <strong>This cannot be undone.</strong>
        </>
      ),
      label: `Type ${workspace.name} to confirm`,
      placeholder: workspace.name,
      confirmLabel: 'Delete workspace',
      tone: 'danger',
      maxLength: 200,
      validate: (value) => (value === workspace.name ? null : 'The name doesn’t match.'),
    });
    if (typed === null) return;
    try {
      await api.del(`/api/workspaces/${workspaceId}`, { confirmName: typed });
      toast(`Deleted “${workspace.name}”`, 'success');
      const other = session.workspaces.find((w) => w.id !== workspaceId);
      router.replace(other ? `/workspaces/${other.id}` : '/');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not delete the workspace.', 'error');
    }
  }

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Settings"
      subtitle={workspace?.name}
    >
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <section className="card p-6">
          <div className="flex items-center gap-3">
            {workspace ? <WorkspaceAvatar id={workspace.id} name={workspace.name} /> : null}
            <div>
              <p className="text-sm font-semibold">Workspace</p>
              <p className="text-xs text-ink-muted">
                Your role: {workspace ? <RoleBadge role={workspace.role} /> : null}
              </p>
            </div>
          </div>

          <form onSubmit={save} className="mt-5">
            <label className="label" htmlFor="name">
              Name
            </label>
            <div className="flex gap-2">
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner}
                maxLength={120}
                required
              />
              <button className="btn-primary h-10" disabled={!isOwner || saving || name.trim() === workspace?.name}>
                <Pencil className="h-4 w-4" aria-hidden /> Save
              </button>
            </div>
            {!isOwner ? <p className="mt-2 text-xs text-ink-muted">Only owners can rename the workspace.</p> : null}
          </form>
        </section>

        <section className="card p-6" aria-labelledby="storage-heading">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <HardDrive className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p id="storage-heading" className="text-sm font-semibold">
                Storage
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Files in the trash still count until they&rsquo;re deleted forever or expire after 30 days.
              </p>
              <div className="mt-4">
                {storage ? (
                  <StorageMeter usedBytes={storage.usedBytes} quotaBytes={storage.quotaBytes} />
                ) : (
                  <div className="h-8 animate-pulse rounded bg-surface-muted" />
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ok-soft text-ok">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold">How this workspace protects documents</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-ink-muted">
                <li>Files live in a private bucket; every download is a signed URL that expires in 60 seconds.</li>
                <li>Share links are 256-bit random tokens stored only as hashes — revocable at any time.</li>
                <li>Removing someone ends their access on their very next request.</li>
                <li>Uploads are checked against their real content, not the name or declared type.</li>
                <li>
                  Every file gets a SHA-256 checksum, so identical copies are spotted and integrity can be verified.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="card border-danger/25 p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
            <div className="flex-1">
              <p className="text-sm font-semibold">Leave workspace</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                You lose access to every document here. Anything you uploaded stays in the workspace. If you&rsquo;re
                the only owner, make someone else an owner first.
              </p>
              <button className="btn-danger mt-4" onClick={() => void leave()}>
                <LogOut className="h-4 w-4" aria-hidden /> Leave workspace
              </button>
            </div>
          </div>
        </section>

        {isOwner ? <WebhooksPanel workspaceId={workspaceId} /> : null}

        {isOwner ? (
          <section className="card border-danger/25 p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger">
                <Trash2 className="h-5 w-5" aria-hidden />
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold">Delete workspace</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  Permanently deletes every document, folder and share link here, and removes everyone&rsquo;s access.
                  To hand the workspace over instead, make someone else an owner on the Members page, then leave.
                </p>
                <button className="btn-danger mt-4" onClick={() => void deleteWorkspace()}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete workspace
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
