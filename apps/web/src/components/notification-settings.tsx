'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api, ApiRequestError, type Schemas } from '@/lib/api';
import { toast } from './toast';
import { ErrorNote, Skeleton } from './ui';

type Preferences = Schemas['NotificationPreferences'];
type NotificationType = Preferences['muted'][number];

/** Every kind of notification, in the words the settings use. */
const TYPES: Array<{ type: NotificationType; label: string }> = [
  { type: 'document.uploaded', label: 'A document is added or updated' },
  { type: 'share.first_open', label: 'One of your links is opened for the first time' },
  { type: 'share.new_viewer', label: 'Someone new opens one of your links' },
  { type: 'share.forwarding_suspected', label: 'One of your links looks forwarded' },
  { type: 'member.joined', label: 'Someone joins a workspace you own' },
  { type: 'member.role_changed', label: 'Your role in a workspace changes' },
  { type: 'member.removed', label: 'You are removed from a workspace' },
  { type: 'workspace.deleted', label: 'A workspace you are in is deleted' },
  { type: 'document.quarantined', label: 'Malware is found in a file you uploaded' },
];

/**
 * What each person hears about: every type shown in the app unless muted (a few that concern
 * their own access or files can't be), chosen types also emailed as they happen, and an optional
 * daily or weekly summary of what is unread.
 */
export function NotificationSettings() {
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<Preferences>('/api/notifications/preferences')
      .then((preferences) => {
        setSaved(preferences);
        setDraft(preferences);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load your settings.'),
      );
  }, []);

  const toggle = (list: 'muted' | 'instant', type: NotificationType, on: boolean) =>
    setDraft((current) =>
      current
        ? { ...current, [list]: on ? [...current[list], type] : current[list].filter((t) => t !== type) }
        : current,
    );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.put<Preferences>('/api/notifications/preferences', {
        digest: draft.digest,
        instant: draft.instant,
        muted: draft.muted,
      });
      setSaved(result);
      setDraft(result);
      toast('Notification settings saved', 'success');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your settings.');
    } finally {
      setSaving(false);
    }
  }

  const changed = JSON.stringify(saved) !== JSON.stringify(draft);

  return (
    <section className="card overflow-hidden" aria-labelledby="notifications-heading">
      <div className="flex items-start gap-3 p-6 pb-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Bell className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 id="notifications-heading" className="text-sm font-semibold">
            Notifications
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Choose what appears under the bell, and what is emailed to you. Emails go only to a confirmed address.
          </p>
        </div>
      </div>
      {error ? (
        <div className="px-6 pb-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {!draft ? (
        !error ? (
          <Skeleton rows={4} />
        ) : null
      ) : (
        <form onSubmit={save}>
          <div className="px-6 pb-4">
            <label className="label" htmlFor="digest">
              Summary email of unread notifications
            </label>
            <select
              id="digest"
              className="input w-auto"
              value={draft.digest}
              onChange={(e) => setDraft({ ...draft, digest: e.target.value as Preferences['digest'] })}
            >
              <option value="off">Never</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken/70 text-xs text-ink-muted">
              <tr>
                <th scope="col" className="px-6 py-2 text-left font-medium">
                  When
                </th>
                <th scope="col" className="w-20 px-2 py-2 font-medium">
                  In app
                </th>
                <th scope="col" className="w-24 px-2 py-2 pr-6 font-medium">
                  Email at once
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {TYPES.map(({ type, label }) => {
                const essential = draft.essential.includes(type);
                return (
                  <tr key={type}>
                    <th scope="row" className="px-6 py-2.5 text-left font-normal">
                      {label}
                      {essential ? <span className="ml-2 text-xs text-ink-subtle">always shown</span> : null}
                    </th>
                    <td className="px-2 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-line-strong"
                        checked={essential || !draft.muted.includes(type)}
                        disabled={essential}
                        onChange={(e) => toggle('muted', type, !e.target.checked)}
                        aria-label={`Show in app: ${label}`}
                      />
                    </td>
                    <td className="px-2 pr-6 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-line-strong"
                        checked={draft.instant.includes(type)}
                        onChange={(e) => toggle('instant', type, e.target.checked)}
                        aria-label={`Email at once: ${label}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex justify-end border-t border-line px-6 py-4">
            <button type="submit" className="btn-primary btn-sm" disabled={saving || !changed}>
              {saving ? 'Saving…' : 'Save notification settings'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
