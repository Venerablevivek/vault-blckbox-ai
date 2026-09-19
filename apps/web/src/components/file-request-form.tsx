'use client';

import { useRef, useState } from 'react';
import { CheckCircle2, FileUp, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { formatBytes } from '@/lib/api';

type Item = {
  key: string;
  file: File;
  state: 'waiting' | 'sending' | 'sent' | 'failed';
  progress: number;
  error?: string;
};

/** Sends one file with upload progress. The name and email go first, as the API expects. */
function send(
  token: string,
  sender: { name: string; email: string },
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ ok: true; remainingFiles: number | null } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('name', sender.name);
    form.append('email', sender.email);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/requests/${encodeURIComponent(token)}/files`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: { remainingFiles?: number | null; error?: { message?: string } } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // Not JSON: keep the generic message below.
      }
      if (xhr.status === 201) resolve({ ok: true, remainingFiles: body.remainingFiles ?? null });
      else resolve({ ok: false, status: xhr.status, message: body.error?.message ?? 'The file could not be sent.' });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, message: 'Network error. Check your connection and retry.' });
    xhr.send(form);
  });
}

/**
 * The upload form on a file request's public page: who you are, then any number of files,
 * sent one at a time with progress. Everything is checked again by the server.
 */
export function FileRequestForm({
  token,
  maxFileBytes,
  remainingFiles: initialRemaining,
}: {
  token: string;
  maxFileBytes: number;
  remainingFiles: number | null;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [remaining, setRemaining] = useState(initialRemaining);
  const [sending, setSending] = useState(false);
  const [closed, setClosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  function add(files: FileList | null) {
    if (!files) return;
    setNotice(null);
    const waiting = items.filter((i) => i.state === 'waiting' || i.state === 'failed').length;
    const room = remaining === null ? Infinity : Math.max(0, remaining - waiting);
    const accepted: Item[] = [];
    const tooBig: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > maxFileBytes) tooBig.push(file.name);
      else if (accepted.length < room) {
        accepted.push({ key: `${file.name}-${file.size}-${Math.random()}`, file, state: 'waiting', progress: 0 });
      }
    }
    const dropped = files.length - accepted.length - tooBig.length;
    const notes = [
      tooBig.length
        ? `${tooBig.join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over ${formatBytes(maxFileBytes)}.`
        : '',
      dropped > 0 ? `Only ${room === 0 ? 'no' : room} more file${room === 1 ? '' : 's'} can be sent.` : '',
    ].filter(Boolean);
    if (notes.length) setNotice(notes.join(' '));
    setItems((current) => [...current, ...accepted]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSending(true);
    setNotice(null);
    for (const item of items.filter((i) => i.state === 'waiting' || i.state === 'failed')) {
      update(item.key, { state: 'sending', progress: 0, error: undefined });
      const result = await send(token, { name: name.trim(), email: email.trim() }, item.file, (progress) =>
        update(item.key, { progress }),
      );
      if (result.ok) {
        update(item.key, { state: 'sent', progress: 1 });
        setRemaining(result.remainingFiles);
      } else {
        update(item.key, { state: 'failed', error: result.message });
        if (result.status === 410 || result.status === 404) {
          setClosed(true);
          break;
        }
      }
    }
    setSending(false);
  }

  const pending = items.filter((i) => i.state === 'waiting' || i.state === 'failed').length;
  const sent = items.filter((i) => i.state === 'sent').length;
  const full = remaining === 0;

  return (
    <form className="panel space-y-5 p-6" onSubmit={(e) => void submit(e)} aria-label="Send files">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Your name</span>
          <input
            className="input"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={sending}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">
            Email <span className="font-normal text-ink-subtle">(optional)</span>
          </span>
          <input
            className="input"
            type="email"
            maxLength={255}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={sending}
          />
        </label>
      </div>

      <div
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-brand-500 bg-brand-50 dark:bg-indigo-950/40' : 'border-line-strong'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!sending && !closed && !full) add(e.dataTransfer.files);
        }}
      >
        <UploadCloud className="h-7 w-7 text-ink-subtle" aria-hidden />
        <p className="text-sm font-medium">Drop files here</p>
        <p className="text-xs text-ink-muted">
          PDF, Office, text or image files, up to {formatBytes(maxFileBytes)} each
        </p>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          aria-label="Choose files to send"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn-secondary btn-sm mt-1"
          onClick={() => input.current?.click()}
          disabled={sending || closed || full}
        >
          <FileUp className="h-3.5 w-3.5" aria-hidden /> Choose files
        </button>
      </div>

      {notice ? (
        <p role="status" className="text-xs text-warn">
          {notice}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Files to send">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-4 py-2.5">
              {item.state === 'sent' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-label="Sent" />
              ) : item.state === 'failed' ? (
                <XCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
              ) : item.state === 'sending' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-600" aria-label="Sending" />
              ) : (
                <FileUp className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.file.name}</p>
                {item.state === 'sending' ? (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className="h-full bg-brand-600 transition-[width]"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </div>
                ) : item.error ? (
                  <p className="text-xs text-danger">{item.error}</p>
                ) : (
                  <p className="text-xs text-ink-muted">{formatBytes(item.file.size)}</p>
                )}
              </div>
              {item.state === 'waiting' && !sending ? (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => setItems((current) => current.filter((i) => i.key !== item.key))}
                >
                  <XCircle className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {sent > 0 && pending === 0 && !sending ? (
        <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
          {sent === 1 ? 'Your file was sent.' : `All ${sent} files were sent.`} You can close this page
          {full || closed ? '.' : ', or send more.'}
        </p>
      ) : null}
      {closed ? (
        <p role="alert" className="text-sm text-danger">
          This request has closed. Files that were not sent can&rsquo;t be sent through this link.
        </p>
      ) : null}

      <button
        type="submit"
        className="btn-primary w-full"
        disabled={sending || closed || pending === 0 || !name.trim()}
      >
        {sending ? 'Sending…' : pending > 0 ? `Send ${pending} file${pending === 1 ? '' : 's'}` : 'Send files'}
      </button>
    </form>
  );
}
