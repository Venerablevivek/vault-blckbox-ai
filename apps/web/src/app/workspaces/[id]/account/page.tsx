'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { KeyRound, Laptop, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { api, ApiRequestError, formatDate, timeAgo, type Session } from '@/lib/api';
import { describeUserAgent } from '@/lib/user-agent';
import { useDialogs } from '@/components/dialog';
import { NotificationSettings } from '@/components/notification-settings';
import { ApiTokens } from '@/components/api-tokens';
import { toast } from '@/components/toast';
import { ErrorNote, Shell, Skeleton, useSession } from '@/components/ui';

type SessionDto = Session;

export default function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);
  const session = useSession(workspaceId);
  const dialogs = useDialogs();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const result = await api.get<{ sessions: SessionDto[] }>('/api/auth/sessions');
      setSessions(result.sessions);
      setSessionsError(null);
    } catch (err) {
      setSessionsError(err instanceof ApiRequestError ? err.message : 'Could not load sessions.');
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError('The two new passwords don’t match.');
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    try {
      const result = await api.post<{ signedOutSessions: number }>('/api/auth/password', {
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast(
        result.signedOutSessions > 0
          ? `Password changed. Signed out ${result.signedOutSessions} other session${result.signedOutSessions === 1 ? '' : 's'}.`
          : 'Password changed',
        'success',
      );
      void loadSessions();
    } catch (err) {
      setPasswordError(err instanceof ApiRequestError ? err.message : 'Could not change password.');
    } finally {
      setSavingPassword(false);
    }
  }

  async function signOutSession(target: SessionDto) {
    const { browser, os } = describeUserAgent(target.userAgent);
    const ok = await dialogs.confirm({
      title: target.current ? 'Sign out of this browser?' : `Sign out ${browser} on ${os}?`,
      body: target.current
        ? 'You’ll need to sign in again here.'
        : 'That session ends immediately. Anyone using it is signed out on their next click.',
      confirmLabel: 'Sign out',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/auth/sessions/${target.id}`);
      if (target.current) {
        window.location.href = '/login';
        return;
      }
      toast('Session signed out', 'success');
      void loadSessions();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not sign out that session.', 'error');
    }
  }

  async function signOutOthers() {
    const ok = await dialogs.confirm({
      title: 'Sign out everywhere else?',
      body: 'Every other browser and device signed in to your account is signed out immediately. This one stays signed in.',
      confirmLabel: 'Sign out others',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const result = await api.del<{ signedOutSessions: number }>('/api/auth/sessions');
      toast(`Signed out ${result.signedOutSessions} session${result.signedOutSessions === 1 ? '' : 's'}`, 'success');
      void loadSessions();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not sign out other sessions.', 'error');
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Account"
      subtitle={session.email}
    >
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <section className="card p-6" aria-labelledby="password-heading">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 id="password-heading" className="text-sm font-semibold">
                Password
              </h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Changing it signs out every other session, revokes your API tokens and emails you a notice.
              </p>
            </div>
          </div>

          <form onSubmit={changePassword} className="mt-5 grid gap-4 sm:grid-cols-2">
            {passwordError ? (
              <div className="sm:col-span-2">
                <ErrorNote message={passwordError} />
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <label className="label" htmlFor="current-password">
                Current password
              </label>
              <input
                id="current-password"
                type="password"
                className="input"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                className="input"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                className="input"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <button className="btn-primary" disabled={savingPassword || !currentPassword || newPassword.length < 8}>
                {savingPassword ? 'Saving…' : 'Change password'}
              </button>
            </div>
          </form>
        </section>

        <section className="card overflow-hidden" aria-labelledby="sessions-heading">
          <div className="flex flex-wrap items-start gap-3 p-6 pb-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ok-soft text-ok">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="sessions-heading" className="text-sm font-semibold">
                Where you&rsquo;re signed in
              </h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                If you don&rsquo;t recognise a session, sign it out and change your password.
              </p>
            </div>
            <button className="btn-secondary btn-sm" onClick={() => void signOutOthers()} disabled={others === 0}>
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out everywhere else
            </button>
          </div>

          {sessionsError ? (
            <div className="px-6 pb-6">
              <ErrorNote message={sessionsError} />
            </div>
          ) : null}
          {!sessions && !sessionsError ? <Skeleton rows={2} /> : null}
          {sessions ? (
            <ul className="divide-y divide-line border-t border-line">
              {sessions.map((s) => {
                const { browser, os, mobile } = describeUserAgent(s.userAgent);
                const Icon = mobile ? Smartphone : Laptop;
                return (
                  <li key={s.id} className="flex items-center gap-4 px-6 py-3.5">
                    <Icon className="h-5 w-5 shrink-0 text-ink-subtle" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {browser} on {os}
                        {s.current ? <span className="chip-ok ml-2 align-middle">This browser</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Active {timeAgo(s.lastSeenAt)} · signed in {formatDate(s.createdAt)}
                      </p>
                    </div>
                    <button className="btn-ghost btn-sm hover:text-danger" onClick={() => void signOutSession(s)}>
                      Sign out
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <NotificationSettings />

        <ApiTokens />
      </div>
    </Shell>
  );
}
