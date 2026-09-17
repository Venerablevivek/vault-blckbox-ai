'use client';

import Link from 'next/link';
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArchiveRestore,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  Info,
  LayoutGrid,
  List,
  Lock,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  api,
  ApiRequestError,
  canContribute,
  formatBytes,
  formatDate,
  ownsOrAdministers,
  timeAgo,
  type DocumentDto,
  type DocumentListResponse,
  type FolderDto,
  type Role,
} from '@/lib/api';
import { useDialogs } from '@/components/dialog';
import { DocumentDetails } from '@/components/document-details';
import { FolderPicker } from '@/components/folder-picker';
import { PreviewModal, PREVIEWABLE } from '@/components/preview-modal';
import { SharePanel } from '@/components/share-panel';
import { toast } from '@/components/toast';
import { cancelDirectUpload, directUpload, UploadCancelled } from '@/lib/direct-upload';
import { EmptyState, ErrorNote, FileGlyph, Shell, Skeleton, StorageMeter, useSession } from '@/components/ui';

type Tab = 'all' | 'shared' | 'mine' | 'trash';
type SortChoice = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc';

const SORTS: Array<{ value: SortChoice; label: string }> = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'size-desc', label: 'Largest first' },
  { value: 'size-asc', label: 'Smallest first' },
];

const PAGE_SIZE = 50;

/** Waits until typing pauses before searching, so the server isn't queried on every key. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

type MoveTarget = { kind: 'document'; doc: DocumentDto } | { kind: 'folder'; folder: FolderDto };

function DocumentsView({ workspaceId }: { workspaceId: string }) {
  const session = useSession(workspaceId);
  const dialogs = useDialogs();
  const router = useRouter();
  const params = useSearchParams();
  const folderId = params.get('folder');

  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), 250);
  const [sort, setSort] = useState<SortChoice>('date-desc');
  const [view, setView] = useState<'list' | 'grid'>('list');

  const [data, setData] = useState<(DocumentListResponse & { trashRetentionDays: number }) | null>(null);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadingName, setUploadingName] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadControl = useRef<{ controller: AbortController; file: File; folderId: string | null } | null>(null);
  /** An upload that stopped. Shown inline, because the person has to decide what to do with it. */
  const [uploadIssue, setUploadIssue] = useState<{
    file: File;
    folderId: string | null;
    message: string;
    resumable: boolean;
  } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);

  const [shareFor, setShareFor] = useState<DocumentDto | null>(null);
  const [previewFor, setPreviewFor] = useState<DocumentDto | null>(null);
  const [detailsFor, setDetailsFor] = useState<DocumentDto | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);

  const role: Role = data?.role ?? session.role;
  const contributor = canContribute(role);
  const trash = tab === 'trash';
  const searching = search.length > 0;

  const buildQuery = useCallback(
    (cursor?: string | null) => {
      const [sortKey, order] = sort.split('-');
      const qs = new URLSearchParams({ sort: sortKey!, order: order!, limit: String(PAGE_SIZE) });
      if (trash) qs.set('view', 'trash');
      else if (tab !== 'all') qs.set('filter', tab);
      if (search) qs.set('q', search);
      if (folderId && !trash) qs.set('folderId', folderId);
      if (cursor) qs.set('cursor', cursor);
      return qs.toString();
    },
    [sort, trash, tab, search, folderId],
  );

  // The query the rows on screen belong to, and the latest request. A tab or search change
  // clears the old rows at once (so active rows never render as trash rows), and a slow earlier
  // response can never overwrite a newer one.
  const shownQuery = useRef<string | null>(null);
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const qs = buildQuery();
    const requestId = ++latestRequest.current;
    if (shownQuery.current !== qs) {
      shownQuery.current = qs;
      setData(null);
      setDocuments([]);
    }
    setLoading(true);
    try {
      const result = await api.get<DocumentListResponse & { trashRetentionDays: number }>(
        `/api/workspaces/${workspaceId}/documents?${qs}`,
      );
      if (requestId !== latestRequest.current) return;
      setData(result);
      setDocuments(result.documents);
      setError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      if (err instanceof ApiRequestError && err.status === 404 && folderId) {
        // The folder was deleted or moved out of reach; fall back to the workspace root.
        router.replace(`/workspaces/${workspaceId}/documents`);
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : 'Failed to load documents.');
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [workspaceId, buildQuery, folderId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const requestId = latestRequest.current;
    try {
      const result = await api.get<DocumentListResponse>(
        `/api/workspaces/${workspaceId}/documents?${buildQuery(data.nextCursor)}`,
      );
      if (requestId !== latestRequest.current) return; // the list was reloaded meanwhile
      setDocuments((current) => [...current, ...result.documents]);
      setData((current) => (current ? { ...current, nextCursor: result.nextCursor } : current));
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not load more documents.', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [data, loadingMore, workspaceId, buildQuery]);

  // Infinite scroll: load the next page as the end of the list comes into view.
  useEffect(() => {
    const node = loadMoreSentinel.current;
    if (!node || !data?.nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [data?.nextCursor, loadMore]);

  // Arriving from the dashboard's Upload button opens the picker straight away.
  useEffect(() => {
    if (params.get('upload') === '1' && contributor) fileInput.current?.click();
  }, [params, contributor]);

  // "/" focuses search; Escape clears it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === 'Escape') {
        setMenuFor(null);
        if (document.activeElement === searchInput.current) {
          setQuery('');
          searchInput.current?.blur();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openFolder = (id: string | null) => {
    setQuery('');
    setTab('all');
    router.push(`/workspaces/${workspaceId}/documents${id ? `?folder=${id}` : ''}`);
  };

  async function uploadFiles(files: FileList | File[]) {
    if (!contributor) return;
    const destination = folderId && !trash ? folderId : null;
    setUploadIssue(null);
    // One file at a time, so there is one clear progress bar and one clear error per file. Each
    // file itself uploads in parallel parts straight to storage, and resumes if interrupted.
    for (const file of Array.from(files)) {
      const controller = new AbortController();
      uploadControl.current = { controller, file, folderId: destination };
      setUploadingName(file.name);
      setUploadPercent(0);
      try {
        await directUpload({
          workspaceId,
          folderId: destination,
          file,
          onProgress: setUploadPercent,
          signal: controller.signal,
        });
        toast(`${file.name} uploaded`, 'success');
      } catch (err) {
        if (err instanceof UploadCancelled) {
          toast(`${file.name}: upload cancelled`);
          break;
        }
        // The API refused the file (type, size, quota): starting again won't help. Anything else
        // (network, storage) left the parts already sent in place, so the upload can resume.
        const refused = err instanceof ApiRequestError && err.status >= 400 && err.status < 500 && err.status !== 409;
        setUploadIssue({
          file,
          folderId: destination,
          message: refused ? (err as ApiRequestError).message : 'The connection was interrupted.',
          resumable: !refused,
        });
        break;
      }
    }
    uploadControl.current = null;
    setUploadPercent(null);
    if (fileInput.current) fileInput.current.value = '';
    await load();
  }

  async function cancelUpload() {
    const current = uploadControl.current;
    if (!current) return;
    // The upload releases its own reserved storage when it sees the abort, including one that was
    // still being opened; this also covers an upload that had already been saved for resuming.
    current.controller.abort();
    await cancelDirectUpload(workspaceId, current.folderId, current.file);
  }

  async function createFolder() {
    const name = await dialogs.prompt({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'e.g. Contracts',
      confirmLabel: 'Create folder',
      maxLength: 120,
      validate: (v) => (/[\\/]/.test(v) ? 'Folder names cannot contain / or \\.' : null),
    });
    if (!name) return;
    try {
      await api.post(`/api/workspaces/${workspaceId}/folders`, { name, parentId: folderId });
      toast(`Folder “${name}” created`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not create folder.', 'error');
    }
  }

  async function renameFolder(folder: FolderDto) {
    setMenuFor(null);
    const name = await dialogs.prompt({
      title: 'Rename folder',
      label: 'Folder name',
      defaultValue: folder.name,
      maxLength: 120,
    });
    if (!name || name === folder.name) return;
    try {
      await api.patch(`/api/workspaces/${workspaceId}/folders/${folder.id}`, { name });
      toast('Folder renamed', 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not rename folder.', 'error');
    }
  }

  async function deleteFolder(folder: FolderDto) {
    setMenuFor(null);
    const ok = await dialogs.confirm({
      title: `Delete “${folder.name}”?`,
      body: 'Only empty folders can be deleted. Move or delete what’s inside first.',
      confirmLabel: 'Delete folder',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/workspaces/${workspaceId}/folders/${folder.id}`);
      toast('Folder deleted', 'success');
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not delete folder.', 'error');
    }
  }

  async function renameDocument(doc: DocumentDto) {
    setMenuFor(null);
    const filename = await dialogs.prompt({ title: 'Rename document', label: 'Name', defaultValue: doc.filename });
    if (!filename || filename === doc.filename) return;
    try {
      await api.patch(`/api/documents/${doc.id}`, { filename });
      setDocuments((docs) => docs.map((d) => (d.id === doc.id ? { ...d, filename } : d)));
      toast('Renamed', 'success');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Rename failed.', 'error');
    }
  }

  async function trashDocument(doc: DocumentDto) {
    setMenuFor(null);
    const shared = (doc.links?.count ?? 0) > 0;
    const ok = await dialogs.confirm({
      title: `Move “${doc.filename}” to the trash?`,
      body: (
        <>
          It can be restored for {data?.trashRetentionDays ?? 30} days.
          {shared ? (
            <strong className="mt-2 block font-medium">
              Its {doc.links!.count} share link{doc.links!.count === 1 ? '' : 's'} will stop working and won&rsquo;t
              come back if you restore it.
            </strong>
          ) : null}
        </>
      ),
      confirmLabel: 'Move to trash',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/documents/${doc.id}`);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      toast(`${doc.filename} moved to the trash`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Delete failed.', 'error');
    }
  }

  async function restoreDocument(doc: DocumentDto) {
    try {
      await api.post(`/api/documents/${doc.id}/restore`);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      toast(`${doc.filename} restored`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Restore failed.', 'error');
    }
  }

  async function purgeDocument(doc: DocumentDto) {
    const ok = await dialogs.confirm({
      title: `Delete “${doc.filename}” forever?`,
      body: 'The file is removed from storage immediately. This cannot be undone.',
      confirmLabel: 'Delete forever',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/documents/${doc.id}/permanent`);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      toast(`${doc.filename} permanently deleted`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Delete failed.', 'error');
    }
  }

  async function completeMove(destination: string | null) {
    const target = moving;
    setMoving(null);
    if (!target) return;
    try {
      if (target.kind === 'document') {
        await api.patch(`/api/documents/${target.doc.id}`, { folderId: destination });
        toast(`Moved ${target.doc.filename}`, 'success');
      } else {
        await api.patch(`/api/workspaces/${workspaceId}/folders/${target.folder.id}`, { parentId: destination });
        toast(`Moved “${target.folder.name}”`, 'success');
      }
      await load();
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Move failed.', 'error');
    }
  }

  const counts = data?.counts;
  const path = data?.path ?? [];
  const folders = trash || searching || tab !== 'all' ? [] : (data?.folders ?? []);
  const canModify = (doc: DocumentDto) => ownsOrAdministers(role, doc.uploadedBy, session.userId);
  const purgeDate = (doc: DocumentDto) =>
    doc.deletedAt ? new Date(new Date(doc.deletedAt).getTime() + (data?.trashRetentionDays ?? 30) * 86_400_000) : null;

  function MenuItem({
    icon: Icon,
    label,
    onClick,
    href,
    danger,
    disabled,
    title,
  }: {
    icon: typeof Download;
    label: string;
    onClick?: () => void;
    href?: string;
    danger?: boolean;
    disabled?: boolean;
    title?: string;
  }) {
    const className = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
      danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-slate-100'
    }`;
    return href ? (
      <a role="menuitem" href={href} className={className} onClick={() => setMenuFor(null)}>
        <Icon className="h-4 w-4 opacity-70" aria-hidden /> {label}
      </a>
    ) : (
      <button role="menuitem" className={className} onClick={onClick} disabled={disabled} title={title}>
        <Icon className="h-4 w-4 opacity-70" aria-hidden /> {label}
      </button>
    );
  }

  function Menu({ id, children }: { id: string; children: React.ReactNode }) {
    return (
      <div className="relative">
        <button
          className="btn-ghost h-8 px-2"
          onClick={() => setMenuFor(menuFor === id ? null : id)}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuFor === id}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuFor === id ? (
          <>
            <button
              className="fixed inset-0 z-10 cursor-default"
              aria-hidden
              tabIndex={-1}
              onClick={() => setMenuFor(null)}
            />
            <div className="panel absolute right-0 top-9 z-20 w-52 animate-rise p-1.5" role="menu">
              {children}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  function DocumentActions({ doc }: { doc: DocumentDto }) {
    if (trash) {
      return (
        <div className="flex items-center gap-1">
          <button
            className="btn-secondary btn-sm"
            onClick={() => void restoreDocument(doc)}
            disabled={!canModify(doc)}
            title={canModify(doc) ? undefined : 'Only the uploader or an owner can restore this'}
          >
            <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> Restore
          </button>
          {role === 'OWNER' ? (
            <button className="btn-ghost btn-sm hover:text-danger" onClick={() => void purgeDocument(doc)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete forever
            </button>
          ) : null}
        </div>
      );
    }
    const previewable = PREVIEWABLE.has(doc.mimeType);
    return (
      <div className="flex items-center gap-1">
        {previewable ? (
          <button
            className="btn-ghost h-8 px-2"
            onClick={() => setPreviewFor(doc)}
            aria-label={`Preview ${doc.filename}`}
            title="Preview"
          >
            <Eye className="h-4 w-4" />
          </button>
        ) : null}
        {contributor ? (
          <button className="btn-secondary btn-sm" onClick={() => setShareFor(doc)}>
            <Share2 className="h-3.5 w-3.5" aria-hidden /> Share
          </button>
        ) : (
          <a className="btn-secondary btn-sm" href={`/api/documents/${doc.id}/download`}>
            <Download className="h-3.5 w-3.5" aria-hidden /> Download
          </a>
        )}
        <Menu id={doc.id}>
          <MenuItem icon={Download} label="Download" href={`/api/documents/${doc.id}/download`} />
          <MenuItem
            icon={Info}
            label="Details"
            onClick={() => {
              setMenuFor(null);
              setDetailsFor(doc);
            }}
          />
          {previewable ? (
            <MenuItem
              icon={Eye}
              label="Preview"
              onClick={() => {
                setMenuFor(null);
                setPreviewFor(doc);
              }}
            />
          ) : null}
          {contributor ? (
            <>
              <MenuItem
                icon={Share2}
                label="Share & activity"
                onClick={() => {
                  setMenuFor(null);
                  setShareFor(doc);
                }}
              />
              <MenuItem
                icon={Pencil}
                label="Rename"
                onClick={() => void renameDocument(doc)}
                disabled={!canModify(doc)}
                title={canModify(doc) ? undefined : 'Only the uploader or an owner can rename this'}
              />
              <MenuItem
                icon={FolderInput}
                label="Move to…"
                onClick={() => {
                  setMenuFor(null);
                  setMoving({ kind: 'document', doc });
                }}
                disabled={!canModify(doc)}
                title={canModify(doc) ? undefined : 'Only the uploader or an owner can move this'}
              />
              <div className="my-1 h-px bg-line" />
              <MenuItem
                icon={Trash2}
                label="Move to trash"
                danger
                onClick={() => void trashDocument(doc)}
                disabled={!canModify(doc)}
                title={canModify(doc) ? undefined : 'Only the uploader or an owner can delete this'}
              />
            </>
          ) : null}
        </Menu>
      </div>
    );
  }

  function LinkChip({ doc }: { doc: DocumentDto }) {
    if (!doc.links || doc.links.count === 0) return null;
    return (
      <span className={doc.links.opens > 0 ? 'chip-ok' : 'chip-brand'}>
        {doc.links.opens > 0 ? <Eye className="h-3 w-3" aria-hidden /> : <Share2 className="h-3 w-3" aria-hidden />}
        {doc.links.opens > 0
          ? `${doc.links.opens} opens`
          : `${doc.links.count} link${doc.links.count === 1 ? '' : 's'} · unopened`}
      </span>
    );
  }

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'all', label: 'All', count: counts?.all },
    { key: 'shared', label: 'Shared', count: counts?.shared },
    { key: 'mine', label: 'Mine', count: counts?.mine },
    { key: 'trash', label: 'Trash', count: counts?.trash },
  ];

  const empty = !loading && documents.length === 0 && folders.length === 0;

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title={trash ? 'Trash' : 'Documents'}
      subtitle={session.workspaces.find((w) => w.id === workspaceId)?.name}
      actions={
        contributor && !trash ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
            />
            <button
              className="btn-secondary hidden sm:inline-flex"
              onClick={() => void createFolder()}
              disabled={searching}
            >
              <FolderPlus className="h-4 w-4" aria-hidden /> New folder
            </button>
            <button
              className="btn-primary"
              onClick={() => fileInput.current?.click()}
              disabled={uploadPercent !== null}
            >
              <UploadCloud className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">
                {uploadPercent !== null ? `Uploading ${uploadPercent}%` : 'Upload'}
              </span>
            </button>
          </>
        ) : null
      }
    >
      <div
        className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6"
        onDragOver={(e) => {
          if (contributor && !trash) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (contributor && !trash && e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {error ? <ErrorNote message={error} /> : null}

        {role === 'VIEWER' ? (
          <div className="flex items-center gap-2 rounded-xl border border-warn/20 bg-warn-soft px-4 py-2.5 text-sm text-warn">
            <Lock className="h-4 w-4 shrink-0" aria-hidden />
            You have read-only access to this workspace: you can view and download documents, but not upload, share or
            change them.
          </div>
        ) : null}

        {data?.storage && contributor && data.storage.usedBytes >= data.storage.quotaBytes * 0.8 ? (
          <div className="card px-4 py-3">
            <StorageMeter usedBytes={data.storage.usedBytes} quotaBytes={data.storage.quotaBytes} compact />
            <p className="mt-1.5 text-xs text-ink-muted">
              Uploads stop when storage is full. Deleting files forever from the trash frees space.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <div
            className="flex rounded-lg border border-line bg-white p-0.5 shadow-card"
            role="tablist"
            aria-label="Filter documents"
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => {
                  setTab(t.key);
                  setMenuFor(null);
                }}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${tab === t.key ? 'bg-brand-600 font-medium text-white' : 'text-ink-muted hover:text-ink'}`}
              >
                {t.key === 'trash' ? <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : null}
                {t.label}
                {t.count !== undefined ? (
                  <span className={`ml-1.5 text-xs ${tab === t.key ? 'text-brand-100' : 'text-ink-subtle'}`}>
                    {t.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="relative ml-auto w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
              aria-hidden
            />
            <input
              ref={searchInput}
              type="search"
              className="input h-9 pl-9 pr-9"
              placeholder={trash ? 'Search the trash' : 'Search all documents'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search documents"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line-strong bg-white px-1.5 text-[10px] text-ink-subtle">
              /
            </kbd>
          </div>

          {!trash ? (
            <select
              className="input h-9 w-auto"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortChoice)}
              aria-label="Sort documents"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : null}

          <div className="flex rounded-lg border border-line bg-white p-0.5 shadow-card">
            <button
              className={`rounded-md p-1.5 ${view === 'list' ? 'bg-slate-100 text-ink' : 'text-ink-subtle'}`}
              onClick={() => setView('list')}
              aria-label="List view"
              aria-pressed={view === 'list'}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              className={`rounded-md p-1.5 ${view === 'grid' ? 'bg-slate-100 text-ink' : 'text-ink-subtle'}`}
              onClick={() => setView('grid')}
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Breadcrumbs: where you are in the folder tree, or what you are searching. */}
        {!trash ? (
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
            {searching ? (
              <span className="text-ink-muted">
                Results for <span className="font-medium text-ink">“{search}”</span> across the whole workspace
              </span>
            ) : (
              <>
                <button
                  onClick={() => openFolder(null)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 ${path.length ? 'text-ink-muted hover:bg-slate-100 hover:text-ink' : 'font-medium text-ink'}`}
                >
                  <Home className="h-3.5 w-3.5" aria-hidden /> All documents
                </button>
                {path.map((f, i) => (
                  <span key={f.id} className="inline-flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5 text-ink-subtle" aria-hidden />
                    <button
                      onClick={() => openFolder(f.id)}
                      aria-current={i === path.length - 1 ? 'page' : undefined}
                      className={`rounded-md px-2 py-1 ${i === path.length - 1 ? 'font-medium text-ink' : 'text-ink-muted hover:bg-slate-100 hover:text-ink'}`}
                    >
                      {f.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </nav>
        ) : (
          <p className="text-sm text-ink-muted">
            Deleted documents stay here for {data?.trashRetentionDays ?? 30} days, then are removed for good.
            {role === 'OWNER' ? ' Owners can delete them forever sooner.' : ''}
          </p>
        )}

        {uploadPercent !== null ? (
          <div className="card flex items-center gap-3 p-3" role="status">
            <UploadCloud className="h-5 w-5 text-brand-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{uploadingName}</p>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600 transition-[width] duration-150"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            </div>
            <span className="text-xs font-medium tabular-nums text-ink-muted">{uploadPercent}%</span>
            <button className="btn-ghost btn-sm" onClick={() => void cancelUpload()}>
              Cancel
            </button>
          </div>
        ) : null}

        {uploadIssue ? (
          <div className="card flex flex-wrap items-center gap-3 border-danger/25 p-3" role="alert">
            <UploadCloud className="h-5 w-5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{uploadIssue.file.name} didn&rsquo;t upload</p>
              <p className="text-xs text-ink-muted">
                {uploadIssue.message}
                {uploadIssue.resumable ? ' Parts already sent are kept, so resuming continues where it stopped.' : ''}
              </p>
            </div>
            {uploadIssue.resumable ? (
              <>
                <button className="btn-primary btn-sm" onClick={() => void uploadFiles([uploadIssue.file])}>
                  Resume upload
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    void cancelDirectUpload(workspaceId, uploadIssue.folderId, uploadIssue.file);
                    setUploadIssue(null);
                  }}
                >
                  Discard
                </button>
              </>
            ) : (
              <button className="btn-ghost btn-sm" onClick={() => setUploadIssue(null)}>
                Dismiss
              </button>
            )}
          </div>
        ) : null}

        {dragging ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-400 bg-brand-50/60 py-10 text-sm font-medium text-brand-700">
            <UploadCloud className="h-5 w-5" aria-hidden /> Drop files to upload
            {path.length ? ` into “${path[path.length - 1]!.name}”` : ''}
          </div>
        ) : null}

        {loading ? (
          <div className="card overflow-hidden">
            <Skeleton rows={5} />
          </div>
        ) : empty ? (
          <div className="card">
            <EmptyState
              icon={trash ? Trash2 : searching ? Search : folderId ? Folder : FileText}
              title={
                trash
                  ? 'The trash is empty'
                  : searching || tab !== 'all'
                    ? 'No documents match'
                    : folderId
                      ? 'This folder is empty'
                      : 'No documents yet'
              }
              hint={
                trash
                  ? 'Deleted documents appear here and can be restored.'
                  : searching || tab !== 'all'
                    ? 'Try a different search or filter.'
                    : contributor
                      ? 'Drag files here or use Upload. Up to 25 MB — PDFs, Office documents, text and images.'
                      : 'Nothing has been shared into this folder yet.'
              }
              action={
                !trash && !searching && tab === 'all' && contributor ? (
                  <button className="btn-primary" onClick={() => fileInput.current?.click()}>
                    <UploadCloud className="h-4 w-4" aria-hidden /> Upload a file
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <div className={view === 'grid' ? 'space-y-3' : 'card'}>
            {view === 'list' && !trash ? (
              <div className="flex items-center gap-4 border-b border-line bg-slate-50/70 px-5 py-2.5 text-xs font-medium text-ink-muted">
                <span className="flex-1">Name</span>
                <span className="hidden w-20 text-right md:block">Size</span>
                <span className="hidden w-28 md:block">Added</span>
                <span className="w-[168px]" />
              </div>
            ) : null}

            <ul
              className={
                view === 'grid'
                  ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                  : 'divide-y divide-line'
              }
            >
              {folders.map((folder) => {
                const mayModify = ownsOrAdministers(role, folder.createdBy, session.userId);
                return (
                  <li
                    key={folder.id}
                    className={
                      view === 'grid'
                        ? 'card flex items-center gap-3 p-4'
                        : 'flex items-center gap-4 px-5 py-3 hover:bg-slate-50/70'
                    }
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"
                      aria-hidden
                    >
                      <Folder className="h-5 w-5" />
                    </span>
                    <button className="min-w-0 flex-1 text-left" onClick={() => openFolder(folder.id)}>
                      <span className="block truncate text-sm font-medium hover:text-brand-700">{folder.name}</span>
                      <span className="block text-xs text-ink-muted">
                        {folder.documentCount ?? 0} document{folder.documentCount === 1 ? '' : 's'}
                        {folder.folderCount
                          ? ` · ${folder.folderCount} folder${folder.folderCount === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </button>
                    {view === 'list' ? <span className="hidden w-20 md:block" /> : null}
                    {view === 'list' ? (
                      <span className="hidden w-28 text-sm text-ink-muted md:block">
                        {formatDate(folder.createdAt)}
                      </span>
                    ) : null}
                    <div className={view === 'list' ? 'flex w-[168px] justify-end' : ''}>
                      {contributor ? (
                        <Menu id={`folder-${folder.id}`}>
                          <MenuItem
                            icon={Folder}
                            label="Open"
                            onClick={() => {
                              setMenuFor(null);
                              openFolder(folder.id);
                            }}
                          />
                          <MenuItem
                            icon={Pencil}
                            label="Rename"
                            onClick={() => void renameFolder(folder)}
                            disabled={!mayModify}
                            title={mayModify ? undefined : 'Only the creator or an owner can rename this folder'}
                          />
                          <MenuItem
                            icon={FolderInput}
                            label="Move to…"
                            onClick={() => {
                              setMenuFor(null);
                              setMoving({ kind: 'folder', folder });
                            }}
                            disabled={!mayModify}
                            title={mayModify ? undefined : 'Only the creator or an owner can move this folder'}
                          />
                          <div className="my-1 h-px bg-line" />
                          <MenuItem
                            icon={Trash2}
                            label="Delete folder"
                            danger
                            onClick={() => void deleteFolder(folder)}
                            disabled={!mayModify}
                            title={mayModify ? undefined : 'Only the creator or an owner can delete this folder'}
                          />
                        </Menu>
                      ) : null}
                    </div>
                  </li>
                );
              })}

              {documents.map((doc) =>
                view === 'grid' ? (
                  <li key={doc.id} className="card flex flex-col p-4 transition-shadow hover:shadow-lift">
                    <div className="flex items-start justify-between">
                      <FileGlyph filename={doc.filename} mimeType={doc.mimeType} />
                      <LinkChip doc={doc} />
                    </div>
                    <p className="mt-3 truncate text-sm font-semibold" title={doc.filename}>
                      {doc.filename}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-muted">
                      {formatBytes(doc.size)} · {timeAgo(trash && doc.deletedAt ? doc.deletedAt : doc.createdAt)}
                    </p>
                    <p className="truncate text-xs text-ink-subtle">
                      {trash ? `Deleted by ${doc.deletedByEmail ?? 'someone'}` : doc.uploadedByEmail}
                    </p>
                    <div className="mt-4 flex justify-end border-t border-line pt-3">
                      <DocumentActions doc={doc} />
                    </div>
                  </li>
                ) : (
                  <li key={doc.id} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-slate-50/70">
                    <FileGlyph filename={doc.filename} mimeType={doc.mimeType} />
                    <div className="min-w-0 flex-1">
                      <button
                        className="block max-w-full truncate text-left text-sm font-medium hover:text-brand-700 disabled:hover:text-ink"
                        onClick={() =>
                          PREVIEWABLE.has(doc.mimeType)
                            ? setPreviewFor(doc)
                            : contributor
                              ? setShareFor(doc)
                              : undefined
                        }
                        disabled={trash}
                        title={doc.filename}
                      >
                        {doc.filename}
                      </button>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                        {trash ? (
                          <>
                            {doc.deletedAt ? (
                              <span>
                                Deleted {timeAgo(doc.deletedAt)} by {doc.deletedByEmail ?? 'someone'}
                              </span>
                            ) : null}
                            {purgeDate(doc) ? (
                              <span className="chip">Purged {formatDate(purgeDate(doc)!.toISOString())}</span>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <span className="truncate">{doc.uploadedByEmail}</span>
                            <LinkChip doc={doc} />
                            {doc.links?.lastAccessedAt ? (
                              <span className="text-ink-subtle">last opened {timeAgo(doc.links.lastAccessedAt)}</span>
                            ) : null}
                            {searching && doc.folderId ? (
                              <Link
                                href={`/workspaces/${workspaceId}/documents?folder=${doc.folderId}`}
                                className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                              >
                                <Folder className="h-3 w-3" aria-hidden /> in a folder
                              </Link>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                    <span className="hidden w-20 text-right text-sm tabular-nums text-ink-muted md:block">
                      {formatBytes(doc.size)}
                    </span>
                    {!trash ? (
                      <span className="hidden w-28 text-sm text-ink-muted md:block">{formatDate(doc.createdAt)}</span>
                    ) : null}
                    <div className={`flex justify-end ${trash ? '' : 'w-[168px]'}`}>
                      <DocumentActions doc={doc} />
                    </div>
                  </li>
                ),
              )}
            </ul>

            {data?.nextCursor ? (
              <div ref={loadMoreSentinel} className="flex justify-center p-4">
                <button className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {shareFor ? (
        <SharePanel
          document={shareFor}
          role={role}
          userId={session.userId}
          onClose={() => setShareFor(null)}
          onChanged={() => void load()}
        />
      ) : null}
      {previewFor ? <PreviewModal document={previewFor} onClose={() => setPreviewFor(null)} /> : null}
      <DocumentDetails document={detailsFor} onClose={() => setDetailsFor(null)} />
      {moving ? (
        <FolderPicker
          workspaceId={workspaceId}
          title={moving.kind === 'document' ? `Move “${moving.doc.filename}”` : `Move folder “${moving.folder.name}”`}
          confirmLabel="Move here"
          currentFolderId={moving.kind === 'document' ? moving.doc.folderId : moving.folder.parentId}
          excludeId={moving.kind === 'folder' ? moving.folder.id : undefined}
          onPick={(destination) => void completeMove(destination)}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </Shell>
  );
}

export default function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <DocumentsView workspaceId={id} />
    </Suspense>
  );
}
