'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { Copy, Crown, Eye, Mail, Send, ShieldCheck, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api, ApiRequestError, formatDate, type Member, type PendingInvitation, type Role } from '@/lib/api';
import { useDialogs } from '@/components/dialog';
import { toast } from '@/components/toast';
import { EmptyState, ErrorNote, RoleBadge, Shell, Skeleton, useSession } from '@/components/ui';

type Invitation = PendingInvitation;

export default function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);
  const session = useSession(workspaceId);

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const dialogs = useDialogs();
  const [role, setRole] = useState<Role>('MEMBER');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('MEMBER');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [lastInviteEmailed, setLastInviteEmailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ role: Role; members: Member[]; invitations: Invitation[] }>(
        `/api/workspaces/${workspaceId}/members`,
      );
      setRole(data.role);
      setMembers(data.members);
      setInvitations(data.invitations);
      setError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      setError(err instanceof ApiRequestError ? err.message : 'Failed to load members.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = role === 'OWNER';
  const ownerCount = members.filter((m) => m.role === 'OWNER').length;

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setLastInviteUrl(null);
    try {
      const result = await api.post<{ inviteUrl?: string; emailSent: boolean }>(`/api/workspaces/${workspaceId}/invitations`, {
        email: inviteEmail,
        role: inviteRole,
      });
      toast(
        result.emailSent
          ? `Invitation emailed to ${inviteEmail}`
          : `Invitation created, but the email to ${inviteEmail} could not be sent. Copy the link below instead.`,
        result.emailSent ? 'success' : 'error',
      );
      setInviteEmail('');
      setLastInviteEmailed(result.emailSent);
      // Returned only when the server exposes invite links (development), so it can be copied.
      if (result.inviteUrl) setLastInviteUrl(result.inviteUrl);
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not send invitation.', 'error');
    } finally {
      setInviteBusy(false);
    }
  }

  async function changeRole(member: Member, next: Role) {
    if (next === 'VIEWER') {
      // Downgrading revokes the person's share links, so say so before doing it.
      const ok = await dialogs.confirm({
        title: `Make ${member.email} a viewer?`,
        body: 'Viewers can view and download, but not upload, share or change anything. Any share links they created will stop working.',
        confirmLabel: 'Make viewer',
        tone: 'danger',
      });
      if (!ok) {
        await load();
        return;
      }
    }
    try {
      await api.patch(`/api/workspaces/${workspaceId}/members/${member.userId}`, { role: next });
      toast(`${member.email} is now ${next === 'OWNER' ? 'an owner' : next === 'MEMBER' ? 'a member' : 'a viewer'}`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not change role.', 'error');
      await load();
    }
  }

  async function removeMember(member: Member) {
    const ok = await dialogs.confirm({
      title: `Remove ${member.email}?`,
      body: 'They lose access immediately, and any share links they created stop working. Documents they uploaded stay in the workspace.',
      confirmLabel: 'Remove member',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/workspaces/${workspaceId}/members/${member.userId}`);
      toast(`${member.email} removed`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not remove member.', 'error');
    }
  }

  async function revokeInvite(invitation: Invitation) {
    try {
      await api.del(`/api/workspaces/${workspaceId}/invitations/${invitation.id}`);
      toast(`Invitation for ${invitation.email} cancelled`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not cancel invitation.', 'error');
    }
  }

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Members"
      subtitle={`${members.length} member${members.length === 1 ? '' : 's'}${invitations.length ? ` · ${invitations.length} pending` : ''}`}
    >
      <div className="mx-auto grid max-w-6xl gap-5 p-4 sm:p-6 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {error ? <ErrorNote message={error} /> : null}

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-ink-subtle" aria-hidden />
                <p className="text-sm font-semibold">People in this workspace</p>
              </div>
              <span className="chip">{members.length}</span>
            </div>
            {loading ? (
              <Skeleton rows={3} />
            ) : (
              <ul className="divide-y divide-line">
                {members.map((member) => {
                  const isSelf = member.userId === session.userId;
                  // The server enforces "at least one owner"; the UI mirrors it so the
                  // control that would fail is disabled with a reason rather than erroring.
                  const lastOwner = member.role === 'OWNER' && ownerCount <= 1;
                  return (
                    <li key={member.userId} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-violet-100 text-sm font-semibold text-brand-700">
                        {member.email.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {member.email}
                          {isSelf ? <span className="text-xs font-normal text-ink-subtle">(you)</span> : null}
                        </p>
                        <p className="text-xs text-ink-muted">Joined {formatDate(member.joinedAt)}</p>
                      </div>

                      {isOwner ? (
                        <div className="flex items-center gap-2">
                          <select
                            className="input h-8 w-28 py-0 text-xs"
                            value={member.role}
                            disabled={lastOwner}
                            title={lastOwner ? 'A workspace needs at least one owner' : undefined}
                            onChange={(e) => void changeRole(member, e.target.value as 'OWNER' | 'MEMBER')}
                            aria-label={`Role for ${member.email}`}
                          >
                            <option value="OWNER">Owner</option>
                            <option value="MEMBER">Member</option>
                            <option value="VIEWER">Viewer</option>
                          </select>
                          <button
                            className="btn-ghost h-8 px-2 hover:text-danger"
                            onClick={() => void removeMember(member)}
                            disabled={lastOwner || isSelf}
                            title={isSelf ? 'Use Settings → Leave workspace' : lastOwner ? 'A workspace needs at least one owner' : 'Remove'}
                            aria-label={`Remove ${member.email}`}
                          >
                            <UserMinus className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <RoleBadge role={member.role} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {isOwner ? (
            <div className="card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-5 py-4">
                <Mail className="h-4 w-4 text-ink-subtle" aria-hidden />
                <p className="text-sm font-semibold">Pending invitations</p>
              </div>
              {invitations.length === 0 ? (
                <EmptyState icon={Mail} title="No pending invitations" />
              ) : (
                <ul className="divide-y divide-line">
                  {invitations.map((invitation) => (
                    <li key={invitation.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-subtle">
                        <Mail className="h-4 w-4" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{invitation.email}</p>
                        <p className="text-xs text-ink-muted">Invited as {invitation.role.toLowerCase()} · expires {formatDate(invitation.expiresAt)}</p>
                      </div>
                      <button className="btn-ghost btn-sm hover:text-danger" onClick={() => void revokeInvite(invitation)}>
                        <X className="h-3.5 w-3.5" aria-hidden /> Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <aside className="space-y-5">
          {isOwner ? (
            <div className="card p-5">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><UserPlus className="h-4 w-4" aria-hidden /></span>
                <p className="text-sm font-semibold">Invite someone</p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                They can create an account or sign in first. The invitation is tied to the address you enter, so a forwarded link won&rsquo;t work for anyone else.
              </p>
              <form onSubmit={invite} className="mt-4 space-y-3">
                <input type="email" required placeholder="colleague@company.com" className="input" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} aria-label="Email address" />
                <select className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Role">
                  <option value="MEMBER">Member — upload, download, share</option>
                  <option value="VIEWER">Viewer — view and download only</option>
                  <option value="OWNER">Owner — also manage people</option>
                </select>
                <button type="submit" className="btn-primary h-10 w-full" disabled={inviteBusy}>
                  <Send className="h-4 w-4" aria-hidden /> {inviteBusy ? 'Inviting…' : 'Send invitation'}
                </button>
              </form>

              {lastInviteUrl ? (
                <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50/60 p-3">
                  <p className="text-xs font-medium text-brand-900">
                    {lastInviteEmailed ? 'Emailed. You can also share the link directly:' : 'The email wasn’t sent. Share this link instead:'}
                  </p>
                  <p className="mt-2 break-all rounded-lg border border-brand-200 bg-white px-2.5 py-2 font-mono text-[11px]">{lastInviteUrl}</p>
                  <button className="btn-primary btn-sm mt-2 w-full" onClick={() => { void navigator.clipboard.writeText(lastInviteUrl); toast('Invitation link copied'); }}>
                    <Copy className="h-3.5 w-3.5" aria-hidden /> Copy link
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="card p-5">
            <p className="text-sm font-semibold">Roles</p>
            <ul className="mt-3 space-y-3 text-xs text-ink-muted">
              <li className="flex gap-2.5">
                <Crown className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
                <span><span className="font-medium text-ink">Owner</span> — everything a member can do, plus invite and remove people, change roles, view the audit trail, and manage any document or link.</span>
              </li>
              <li className="flex gap-2.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                <span><span className="font-medium text-ink">Member</span> — upload, download, preview, share and create folders. Rename, move or delete only what they created.</span>
              </li>
              <li className="flex gap-2.5">
                <Eye className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <span><span className="font-medium text-ink">Viewer</span> — view and download only. Can&rsquo;t upload, share or change anything, so documents can&rsquo;t leave the workspace through them.</span>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </Shell>
  );
}
