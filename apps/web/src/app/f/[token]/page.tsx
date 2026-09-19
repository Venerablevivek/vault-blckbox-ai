import Link from 'next/link';
import { headers } from 'next/headers';
import { ChevronRight, Download, Folder } from 'lucide-react';
import { FolderZipButton } from '@/components/folder-zip-button';
import { DeadLink, expiryLabel, Frame, kindOf } from '@/components/share-page';
import { SharePasswordForm } from '@/components/share-password-form';
import { ViewBeacon } from '@/components/view-beacon';
import { formatBytes } from '@/lib/api';

/**
 * The public page for a shared folder. Like the document page it is rendered on the server,
 * reveals nothing until a password (if any) is given, and says plainly what the sender can see.
 * The recipient can move down through the folder and back up to it, never above it.
 */
export const dynamic = 'force-dynamic';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

type FolderMeta =
  | { locked: true; expiresAt: string | null }
  | {
      locked: false;
      name: string;
      expiresAt: string | null;
      passwordProtected: boolean;
      path: Array<{ id: string; name: string }>;
      folders: Array<{ id: string; name: string; documentCount: number; folderCount: number }>;
      documents: Array<{ id: string; filename: string; mimeType: string; size: number; createdAt: string }>;
      truncated: boolean;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FolderSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ folder?: string }>;
}) {
  const { token } = await params;
  const { folder } = await searchParams;
  const folderId = folder && UUID.test(folder) ? folder : null;

  // As on the document page: pass on the visitor's address and the browser's cookies (an
  // unlocked link is an HttpOnly cookie the API set).
  const incoming = await headers();
  const clientIp = incoming.get('x-forwarded-for') ?? '';
  const cookie = incoming.get('cookie') ?? '';
  const response = await fetch(
    `${API}/api/folder-shares/${encodeURIComponent(token)}${folderId ? `?folderId=${folderId}` : ''}`,
    {
      cache: 'no-store',
      headers: { ...(clientIp ? { 'x-forwarded-for': clientIp } : {}), ...(cookie ? { cookie } : {}) },
    },
  );

  if (!response.ok) {
    return (
      <Frame>
        <DeadLink gone={response.status === 410} usedUp={false} />
      </Frame>
    );
  }

  const meta = (await response.json()) as FolderMeta;
  const pagePath = `/f/${encodeURIComponent(token)}`;

  if (meta.locked) {
    return (
      <Frame>
        <div className="panel overflow-hidden">
          <div className="bg-gradient-to-br from-brand-600 dark:from-indigo-600 to-brand-700 dark:to-indigo-800 px-8 py-9 text-center">
            <span
              className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/25"
              aria-hidden
            >
              <Folder className="h-6 w-6" />
            </span>
            <h1 className="mt-4 text-lg font-semibold text-white">This folder is password protected</h1>
            <p className="mt-1 text-sm text-indigo-100">Enter the password the sender gave you.</p>
          </div>
          <SharePasswordForm token={token} kind="folder-shares" />
          <p className="border-t border-line px-8 py-4 text-center text-[11px] leading-relaxed text-ink-subtle">
            {expiryLabel(meta.expiresAt)}. Wrong attempts are limited.
          </p>
        </div>
      </Frame>
    );
  }

  const current = meta.path[meta.path.length - 1]!;
  const atTop = meta.path.length === 1;
  const empty = meta.folders.length === 0 && meta.documents.length === 0;

  return (
    <Frame wide>
      {atTop ? <ViewBeacon token={token} kind="folder-shares" /> : null}
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm text-ink-muted">
              {meta.path.map((step, index) => (
                <span key={step.id} className="flex items-center gap-1">
                  {index > 0 ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : null}
                  {index === meta.path.length - 1 ? (
                    <span className="font-medium text-ink" aria-current="page">
                      {step.name}
                    </span>
                  ) : (
                    <Link
                      className="hover:text-brand-700 hover:underline"
                      href={index === 0 ? pagePath : `${pagePath}?folder=${step.id}`}
                    >
                      {step.name}
                    </Link>
                  )}
                </span>
              ))}
            </nav>
            <h1 className="mt-1 truncate text-lg font-semibold">{current.name}</h1>
            <p className="text-xs text-ink-muted">Shared folder · {expiryLabel(meta.expiresAt)}</p>
          </div>
          {!empty ? (
            <div className="w-full sm:w-56">
              <FolderZipButton
                token={token}
                folderId={atTop ? null : current.id}
                label={atTop ? 'Download all (zip)' : 'Download this folder'}
              />
            </div>
          ) : null}
        </div>

        {empty ? (
          <p className="px-6 py-12 text-center text-sm text-ink-muted">This folder is empty.</p>
        ) : (
          <ul className="divide-y divide-line">
            {meta.folders.map((sub) => (
              <li key={sub.id}>
                <Link
                  href={`${pagePath}?folder=${sub.id}`}
                  className="flex items-center gap-3 px-6 py-3 hover:bg-surface-sunken/70"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                    aria-hidden
                  >
                    <Folder className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{sub.name}</span>
                    <span className="block text-xs text-ink-muted">
                      {sub.documentCount} file{sub.documentCount === 1 ? '' : 's'}
                      {sub.folderCount ? ` · ${sub.folderCount} folder${sub.folderCount === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-ink-subtle" aria-hidden />
                </Link>
              </li>
            ))}
            {meta.documents.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 px-6 py-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-[10px] font-bold text-ink-muted"
                  aria-hidden
                >
                  {(doc.filename.split('.').pop() ?? '?').slice(0, 4).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{doc.filename}</span>
                  <span className="block text-xs text-ink-muted">
                    {formatBytes(doc.size)} · {kindOf(doc.mimeType)}
                  </span>
                </span>
                <a
                  className="btn-secondary btn-sm"
                  href={`/api/folder-shares/${encodeURIComponent(token)}/documents/${doc.id}/download`}
                  aria-label={`Download ${doc.filename}`}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Download</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {meta.truncated ? (
          <p className="border-t border-line px-6 py-3 text-xs text-ink-muted">
            This folder holds more than 500 items; only the first 500 are listed. Download it as a zip to get
            everything.
          </p>
        ) : null}
        <p className="border-t border-line px-6 py-4 text-center text-[11px] leading-relaxed text-ink-subtle">
          Shared securely. The sender can see how often this folder is opened and downloaded, and can revoke the link at
          any time.
        </p>
      </div>
    </Frame>
  );
}
