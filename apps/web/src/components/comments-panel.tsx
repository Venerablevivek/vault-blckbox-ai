'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { api, ApiRequestError, formatDate, timeAgo, type DocumentComment, type DocumentDto } from '@/lib/api';
import { Modal, useDialogs } from './dialog';
import { toast } from './toast';
import { ErrorNote } from './ui';

const MAX_LENGTH = 2000;

/**
 * A document's discussion thread. Every member of the workspace can read and write it, viewers
 * included; a comment can be edited by its author and deleted by its author or an owner. The
 * server says which, per comment, so this component holds no permission rules of its own.
 */
export function CommentsPanel({ document: doc, onClose }: { document: DocumentDto; onClose: () => void }) {
  const dialogs = useDialogs();
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listEnd = useRef<HTMLLIElement>(null);

  const load = useCallback(async () => {
    try {
      setComments((await api.get<{ comments: DocumentComment[] }>(`/api/documents/${doc.id}/comments`)).comments);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load comments.');
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const { comment } = await api.post<{ comment: DocumentComment }>(`/api/documents/${doc.id}/comments`, {
        body,
      });
      setComments((current) => [...current, comment]);
      setDraft('');
      requestAnimationFrame(() => listEnd.current?.scrollIntoView({ block: 'nearest' }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not post your comment.');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || !editing.body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { comment } = await api.patch<{ comment: DocumentComment }>(
        `/api/documents/${doc.id}/comments/${editing.id}`,
        { body: editing.body },
      );
      setComments((current) => current.map((c) => (c.id === comment.id ? comment : c)));
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your changes.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: DocumentComment) {
    const ok = await dialogs.confirm({
      title: 'Delete this comment?',
      body: 'It is removed for everyone in the workspace. This cannot be undone.',
      confirmLabel: 'Delete comment',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/documents/${doc.id}/comments/${comment.id}`);
      setComments((current) => current.filter((c) => c.id !== comment.id));
      toast('Comment deleted', 'success');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete that comment.');
    } finally {
      setBusy(false);
    }
  }

  const submitOnShortcut = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      action();
    }
  };

  return (
    <Modal open onClose={onClose} title={`Comments on “${doc.filename}”`} size="lg">
      <div className="space-y-4">
        {error ? <ErrorNote message={error} /> : null}

        {loading ? (
          <div className="h-24 animate-pulse rounded-xl bg-surface-muted" />
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
            <MessageSquare className="h-6 w-6 text-ink-subtle" aria-hidden />
            <p className="text-sm font-medium">No comments yet</p>
            <p className="text-xs text-ink-muted">Start the discussion. Everyone in the workspace can see it.</p>
          </div>
        ) : (
          <ol className="max-h-[50vh] space-y-3 overflow-y-auto pr-1" aria-label="Comments">
            {comments.map((c) => (
              <li key={c.id} className="rounded-xl border border-line bg-surface px-4 py-3">
                <div className="flex items-start gap-3">
                  <span
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold uppercase text-brand-700 dark:bg-indigo-950 dark:text-indigo-200"
                    aria-hidden
                  >
                    {c.authorEmail.slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-sm font-medium">{c.authorEmail}</span>
                      <span className="text-xs text-ink-subtle" title={formatDate(c.createdAt)}>
                        {timeAgo(c.createdAt)}
                        {c.editedAt ? ' · edited' : ''}
                      </span>
                    </div>
                    {editing?.id === c.id ? (
                      <div className="mt-2 space-y-2">
                        <textarea
                          className="input min-h-20"
                          aria-label="Edit comment"
                          maxLength={MAX_LENGTH}
                          value={editing.body}
                          onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                          onKeyDown={(e) => submitOnShortcut(e, () => void saveEdit())}
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <button className="btn-ghost btn-sm" onClick={() => setEditing(null)} disabled={busy}>
                            Cancel
                          </button>
                          <button
                            className="btn-primary btn-sm"
                            onClick={() => void saveEdit()}
                            disabled={busy || !editing.body.trim()}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{c.body}</p>
                    )}
                  </div>
                  {editing?.id !== c.id && (c.canEdit || c.canDelete) ? (
                    <div className="flex shrink-0 gap-1">
                      {c.canEdit ? (
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => setEditing({ id: c.id, body: c.body })}
                          disabled={busy}
                          aria-label="Edit comment"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                      {c.canDelete ? (
                        <button
                          className="btn-ghost btn-sm hover:text-danger"
                          onClick={() => void remove(c)}
                          disabled={busy}
                          aria-label="Delete comment"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
            <li ref={listEnd} aria-hidden className="h-0" />
          </ol>
        )}

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <textarea
            className="input min-h-20"
            aria-label="New comment"
            placeholder="Write a comment…"
            maxLength={MAX_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => submitOnShortcut(e, () => void post())}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink-subtle">
              The uploader and everyone in this thread are notified. ⌘/Ctrl + Enter to send.
            </p>
            <button type="submit" className="btn-primary btn-sm" disabled={busy || !draft.trim()}>
              {busy ? 'Posting…' : 'Comment'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
