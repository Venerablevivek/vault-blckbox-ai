'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { api, ApiRequestError, timeAgo, type Schemas } from '@/lib/api';
import { useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

type Webhook = Schemas['Webhook'];
type Delivery = Schemas['WebhookDelivery'];

/** The activity worth sending somewhere else, grouped the way owners think about it. */
const EVENT_GROUPS: Array<{ label: string; events: Array<{ event: string; label: string }> }> = [
  {
    label: 'Documents',
    events: [
      { event: 'document.uploaded', label: 'Uploaded' },
      { event: 'document.version_uploaded', label: 'New version' },
      { event: 'document.comment_added', label: 'Commented' },
      { event: 'file_request.created', label: 'File request created' },
      { event: 'file_request.revoked', label: 'File request closed' },
      { event: 'document.renamed', label: 'Renamed' },
      { event: 'document.moved', label: 'Moved' },
      { event: 'document.trashed', label: 'Moved to trash' },
      { event: 'document.restored', label: 'Restored' },
      { event: 'document.purged', label: 'Deleted for good' },
      { event: 'document.quarantined', label: 'Malware found' },
    ],
  },
  {
    label: 'Sharing',
    events: [
      { event: 'share.created', label: 'Link created' },
      { event: 'share.revoked', label: 'Link revoked' },
      { event: 'share.accessed', label: 'Link opened' },
      { event: 'share.blocked', label: 'Link refused' },
    ],
  },
  {
    label: 'People',
    events: [
      { event: 'member.invited', label: 'Invited' },
      { event: 'member.joined', label: 'Joined' },
      { event: 'member.removed', label: 'Removed' },
      { event: 'member.left', label: 'Left' },
      { event: 'member.role_changed', label: 'Role changed' },
    ],
  },
];

/** Owners send chosen workspace activity, signed, to their own HTTPS endpoints. */
export function WebhooksPanel({ workspaceId }: { workspaceId: string }) {
  const dialogs = useDialogs();
  const base = `/api/workspaces/${workspaceId}/webhooks`;
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['document.uploaded']);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const load = useCallback(async () => {
    try {
      setHooks((await api.get<{ webhooks: Webhook[] }>(base)).webhooks);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load webhooks.');
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<{ webhook: Webhook; secret: string }>(base, { url, events });
      setSecret(result.secret);
      setCopied(false);
      setUrl('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add the webhook.');
    } finally {
      setCreating(false);
    }
  }

  async function act(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast(done, 'success');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'That did not work.');
    }
  }

  async function ping(hook: Webhook) {
    try {
      const result = await api.post<{ success: boolean; statusCode: number | null; error: string | null }>(
        `${base}/${hook.id}/ping`,
      );
      toast(
        result.success ? `Test delivered (HTTP ${result.statusCode})` : `Test failed: ${result.error}`,
        result.success ? 'success' : 'error',
      );
      await load();
      if (open === hook.id) await showDeliveries(hook.id);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the test.');
    }
  }

  async function showDeliveries(id: string) {
    setOpen(id);
    setDeliveries((await api.get<{ deliveries: Delivery[] }>(`${base}/${id}/deliveries`)).deliveries);
  }

  async function remove(hook: Webhook) {
    const ok = await dialogs.confirm({
      title: 'Remove this webhook?',
      body: `Nothing more will be sent to ${hook.url}.`,
      confirmLabel: 'Remove webhook',
      tone: 'danger',
    });
    if (ok) await act(() => api.del(`${base}/${hook.id}`), 'Webhook removed');
  }

  return (
    <section className="card p-6" aria-labelledby="webhooks-heading">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">
          <WebhookIcon className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 id="webhooks-heading" className="text-sm font-semibold">
            Webhooks
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Send chosen activity to your own HTTPS endpoint as signed JSON. Failed deliveries are retried; a webhook
            that keeps failing is switched off.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {error ? <ErrorNote message={error} /> : null}

        {secret ? (
          <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4" role="status">
            <p className="text-sm font-medium text-brand-900">
              Copy the signing secret now. It won&rsquo;t be shown again.
            </p>
            <p
              className="mt-2 break-all rounded-lg border border-brand-200 bg-surface px-3 py-2 font-mono text-xs"
              data-testid="webhook-secret"
            >
              {secret}
            </p>
            <p className="mt-2 text-xs text-brand-900/70">
              Each delivery has a Vault-Signature header: t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of &ldquo;t.body&rdquo; with
              this secret&gt;. Check it, and reject old times.
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
                {copied ? 'Copied' : 'Copy secret'}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setSecret(null)}>
                Done
              </button>
            </div>
          </div>
        ) : null}

        {hooks && hooks.length > 0 ? (
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Webhooks">
            {hooks.map((hook) => (
              <li key={hook.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs" title={hook.url}>
                      {hook.url}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {hook.enabled ? (
                        <span className="chip-ok">On</span>
                      ) : (
                        <span className="chip-warn" title={hook.disabledReason ?? undefined}>
                          Off{hook.disabledReason ? `: ${hook.disabledReason}` : ''}
                        </span>
                      )}{' '}
                      {hook.events.length} event{hook.events.length === 1 ? '' : 's'}
                      {hook.lastDeliveryAt
                        ? ` · last sent ${timeAgo(hook.lastDeliveryAt)} (HTTP ${hook.lastStatus ?? '—'})`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button className="btn-ghost btn-sm" onClick={() => void ping(hook)}>
                      <Send className="h-3.5 w-3.5" aria-hidden /> Send test
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => void (open === hook.id ? setOpen(null) : showDeliveries(hook.id))}
                      aria-expanded={open === hook.id}
                    >
                      Deliveries
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() =>
                        void act(
                          () => api.patch(`${base}/${hook.id}`, { enabled: !hook.enabled }),
                          hook.enabled ? 'Webhook switched off' : 'Webhook switched on',
                        )
                      }
                    >
                      {hook.enabled ? 'Switch off' : 'Switch on'}
                    </button>
                    <button
                      className="btn-ghost btn-sm hover:text-danger"
                      onClick={() => void remove(hook)}
                      aria-label={`Remove webhook ${hook.url}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
                {open === hook.id ? (
                  <ul
                    className="mt-3 divide-y divide-line rounded-lg bg-surface-sunken text-xs"
                    aria-label="Recent deliveries"
                  >
                    {deliveries.length === 0 ? (
                      <li className="px-3 py-2 text-ink-muted">Nothing sent yet.</li>
                    ) : (
                      deliveries.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <span className={d.success ? 'chip-ok' : 'chip-warn'}>
                            {d.success ? `HTTP ${d.statusCode}` : d.statusCode ? `HTTP ${d.statusCode}` : 'failed'}
                          </span>
                          <span className="font-mono">{d.eventType}</span>
                          {d.error && !d.success ? <span className="text-ink-muted">{d.error}</span> : null}
                          <span className="ml-auto text-ink-subtle">
                            {d.durationMs} ms · {timeAgo(d.attemptedAt)}
                          </span>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : hooks ? (
          <p className="text-sm text-ink-muted">No webhooks yet.</p>
        ) : null}

        <form onSubmit={create} className="space-y-3 rounded-xl border border-dashed border-line-strong p-4">
          <div>
            <label className="label" htmlFor="webhook-url">
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              type="url"
              className="input font-mono text-xs"
              placeholder="https://example.com/hooks/vault"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <fieldset>
            <legend className="label">Send</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {EVENT_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="mb-1 text-xs font-semibold text-ink-muted">{group.label}</p>
                  {group.events.map(({ event, label }) => (
                    <label key={event} className="flex items-center gap-2 py-0.5 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-line-strong"
                        checked={events.includes(event)}
                        onChange={(e) =>
                          setEvents((current) =>
                            e.target.checked ? [...current, event] : current.filter((x) => x !== event),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary btn-sm" disabled={creating || !url || events.length === 0}>
              {creating ? 'Adding…' : 'Add webhook'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
