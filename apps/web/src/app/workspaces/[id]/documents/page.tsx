'use client';

import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  FileText,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { api, ApiRequestError, formatBytes, formatDate, timeAgo, type DocumentDto } from '@/lib/api';
import { PreviewModal, PREVIEWABLE } from '@/components/preview-modal';
import { SharePanel } from '@/components/share-panel';
import { toast } from '@/components/toast';
import { EmptyState, ErrorNote, FileGlyph, Shell, Skeleton, useSession } from '@/components/ui';

type SortKey = 'name' | 'size' | 'date';
type Filter = 'all' | 'shared' | 'mine';

function DocumentsView({ workspaceId }: { workspaceId: string }) {
  const session = useSession(workspaceId);
  const params = useSearchParams();

  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [role, setRole] = useState<'OWNER' | 'MEMBER'>('MEMBER');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [ascending, setAscending] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'list' | 'grid'>('list');

  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadingName, setUploadingName] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const [shareFor, setShareFor] = useState<DocumentDto | null>(null);
  const [previewFor, setPreviewFor] = useState<DocumentDto | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.get<{ role: 'OWNER' | 'MEMBER'; documents: DocumentDto[] }>(
        `/api/workspaces/${workspaceId}/documents`,
      );
      setRole(list.role);
      setDocuments(list.documents);
      setError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      // A non-member gets 404 here — identical to a workspace that does not exist.
      setError(err instanceof ApiRequestError ? err.message : 'Failed to load documents.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Arriving from the dashboard's Upload button opens the picker straight away.
  useEffect(() => {
    if (params.get('upload') === '1') fileInput.current?.click();
  }, [params]);

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

  async function uploadFiles(files: FileList | File[]) {
    // Sequential on purpose: one clear progress bar and one clear error per file, rather
    // than several interleaved.
    for (const file of Array.from(files)) {
      setUploadingName(file.name);
      setUploadPercent(0);
      try {
        await api.upload(`/api/workspaces/${workspaceId}/documents`, file, setUploadPercent);
        toast(`${file.name} uploaded`, 'success');
      } catch (err) {
        toast(`${file.name}: ${err instanceof ApiRequestError ? err.message : 'upload failed'}`, 'error');
      }
    }
    setUploadPercent(null);
    if (fileInput.current) fileInput.current.value = '';
    await load();
  }

  async function remove(doc: DocumentDto) {
    setMenuFor(null);
    if (!confirm(`Delete “${doc.filename}”? Any share links to it stop working immediately.`)) return;
    try {
      await api.del(`/api/documents/${doc.id}`);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      toast(`${doc.filename} deleted`, 'success');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Delete failed.', 'error');
    }
  }

  async function rename(doc: DocumentDto) {
    setMenuFor(null);
    const next = prompt('Rename document', doc.filename);
    if (!next || next.trim() === doc.filename) return;
    try {
      await api.patch(`/api/documents/${doc.id}`, { filename: next.trim() });
      setDocuments((docs) => docs.map((d) => (d.id === doc.id ? { ...d, filename: next.trim() } : d)));
      toast('Renamed', 'success');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Rename failed.', 'error');
    }
  }

  function toggleSort(key: SortKey) {
    if (sort === key) return setAscending((v) => !v);
    setSort(key);
    setAscending(key === 'name');
  }

  const canModify = (doc: DocumentDto) => role === 'OWNER' || doc.uploadedBy === session.userId;

  const visible = documents
    .filter((d) => (query ? d.filename.toLowerCase().includes(query.toLowerCase()) : true))
    .filter((d) => (filter === 'shared' ? (d.links?.count ?? 0) > 0 : filter === 'mine' ? d.uploadedBy === session.userId : true))
    .sort((a, b) => {
      const dir = ascending ? 1 : -1;
      if (sort === 'name') return a.filename.localeCompare(b.filename) * dir;
      if (sort === 'size') return (a.size - b.size) * dir;
      return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
    });

  const counts = {
    all: documents.length,
    shared: documents.filter((d) => (d.links?.count ?? 0) > 0).length,
    mine: documents.filter((d) => d.uploadedBy === session.userId).length,
  };

  function Actions({ doc }: { doc: DocumentDto }) {
    const previewable = PREVIEWABLE.has(doc.mimeType);
    return (
      <div className="relative flex items-center gap-1">
        {previewable ? (
          <button className="btn-ghost h-8 px-2" onClick={() => setPreviewFor(doc)} aria-label={`Preview ${doc.filename}`} title="Preview">
            <Eye className="h-4 w-4" />
          </button>
        ) : null}
        <button className="btn-secondary btn-sm" onClick={() => setShareFor(doc)}>
          <Share2 className="h-3.5 w-3.5" aria-hidden /> Share
        </button>
        <button
          className="btn-ghost h-8 px-2"
          onClick={() => setMenuFor(menuFor === doc.id ? null : doc.id)}
          aria-label={`More actions for ${doc.filename}`}
          aria-haspopup="menu"
          aria-expanded={menuFor === doc.id}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {menuFor === doc.id ? (
          <>
            <button className="fixed inset-0 z-10 cursor-default" aria-hidden tabIndex={-1} onClick={() => setMenuFor(null)} />
            <div className="panel absolute right-0 top-9 z-20 w-48 animate-rise p-1.5" role="menu">
              <a role="menuitem" href={`/api/documents/${doc.id}/download`} onClick={() => setMenuFor(null)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-slate-100">
                <Download className="h-4 w-4 text-ink-subtle" aria-hidden /> Download
              </a>
              {previewable ? (
                <button role="menuitem" onClick={() => { setMenuFor(null); setPreviewFor(doc); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-slate-100">
                  <Eye className="h-4 w-4 text-ink-subtle" aria-hidden /> Preview
                </button>
              ) : null}
              <button
                role="menuitem"
                onClick={() => void rename(doc)}
                disabled={!canModify(doc)}
                title={canModify(doc) ? undefined : 'Only the uploader or an owner can rename this'}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Pencil className="h-4 w-4 text-ink-subtle" aria-hidden /> Rename
              </button>
              <div className="my-1 h-px bg-line" />
              <button
                role="menuitem"
                onClick={() => void remove(doc)}
                disabled={!canModify(doc)}
                title={canModify(doc) ? undefined : 'Only the uploader or an owner can delete this'}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Delete
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  function LinkChip({ doc }: { doc: DocumentDto }) {
    if (!doc.links || doc.links.count === 0) return null;
    return (
      <span className={doc.links.opens > 0 ? 'chip-ok' : 'chip-brand'}>
        {doc.links.opens > 0 ? <Eye className="h-3 w-3" aria-hidden /> : <Share2 className="h-3 w-3" aria-hidden />}
        {doc.links.opens > 0 ? `${doc.links.opens} opens` : `${doc.links.count} link${doc.links.count === 1 ? '' : 's'} · unopened`}
      </span>
    );
  }

  const SortIcon = ascending ? ArrowUp : ArrowDown;

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Documents"
      subtitle={session.workspaces.find((w) => w.id === workspaceId)?.name}
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
          />
          <button className="btn-primary" onClick={() => fileInput.current?.click()} disabled={uploadPercent !== null}>
            <UploadCloud className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{uploadPercent !== null ? `Uploading ${uploadPercent}%` : 'Upload'}</span>
          </button>
        </>
      }
    >
      <div
        className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files); }}
      >
        {error ? <ErrorNote message={error} /> : null}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-line bg-white p-0.5 shadow-card" role="tablist" aria-label="Filter documents">
            {(['all', 'shared', 'mine'] as Filter[]).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${filter === key ? 'bg-brand-600 font-medium text-white' : 'text-ink-muted hover:text-ink'}`}
              >
                {key === 'all' ? 'All' : key === 'shared' ? 'Shared' : 'Uploaded by me'}
                <span className={`ml-1.5 text-xs ${filter === key ? 'text-brand-100' : 'text-ink-subtle'}`}>{counts[key]}</span>
              </button>
            ))}
          </div>

          <div className="relative ml-auto w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden />
            <input
              ref={searchInput}
              type="search"
              className="input h-9 pl-9 pr-9"
              placeholder="Search documents"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search documents"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line-strong bg-white px-1.5 text-[10px] text-ink-subtle">/</kbd>
          </div>

          <div className="flex rounded-lg border border-line bg-white p-0.5 shadow-card">
            <button className={`rounded-md p-1.5 ${view === 'list' ? 'bg-slate-100 text-ink' : 'text-ink-subtle'}`} onClick={() => setView('list')} aria-label="List view" aria-pressed={view === 'list'}>
              <List className="h-4 w-4" />
            </button>
            <button className={`rounded-md p-1.5 ${view === 'grid' ? 'bg-slate-100 text-ink' : 'text-ink-subtle'}`} onClick={() => setView('grid')} aria-label="Grid view" aria-pressed={view === 'grid'}>
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>

        {uploadPercent !== null ? (
          <div className="card flex items-center gap-3 p-3">
            <UploadCloud className="h-5 w-5 text-brand-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{uploadingName}</p>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-600 transition-[width] duration-150" style={{ width: `${uploadPercent}%` }} />
              </div>
            </div>
            <span className="text-xs font-medium tabular-nums text-ink-muted">{uploadPercent}%</span>
          </div>
        ) : null}

        {dragging ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-400 bg-brand-50/60 py-10 text-sm font-medium text-brand-700">
            <UploadCloud className="h-5 w-5" aria-hidden /> Drop files to upload
          </div>
        ) : null}

        {loading ? (
          <div className="card overflow-hidden"><Skeleton rows={5} /></div>
        ) : visible.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={query ? Search : FileText}
              title={query || filter !== 'all' ? 'No documents match' : 'No documents yet'}
              hint={query || filter !== 'all' ? 'Try a different search or filter.' : 'Drag files here or use Upload. Up to 25 MB — PDFs, Office documents, text and images.'}
              action={!query && filter === 'all' ? (
                <button className="btn-primary" onClick={() => fileInput.current?.click()}>
                  <UploadCloud className="h-4 w-4" aria-hidden /> Upload your first file
                </button>
              ) : null}
            />
          </div>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((doc) => (
              <li key={doc.id} className="card flex flex-col p-4 transition-shadow hover:shadow-lift">
                <div className="flex items-start justify-between">
                  <FileGlyph filename={doc.filename} mimeType={doc.mimeType} />
                  <LinkChip doc={doc} />
                </div>
                <p className="mt-3 truncate text-sm font-semibold" title={doc.filename}>{doc.filename}</p>
                <p className="mt-0.5 truncate text-xs text-ink-muted">{formatBytes(doc.size)} · {timeAgo(doc.createdAt)}</p>
                <p className="truncate text-xs text-ink-subtle">{doc.uploadedByEmail}</p>
                <div className="mt-4 flex justify-end border-t border-line pt-3"><Actions doc={doc} /></div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card">
            <div className="flex items-center gap-4 border-b border-line bg-slate-50/70 px-5 py-2.5 text-xs font-medium text-ink-muted">
              <button className="flex flex-1 items-center gap-1 text-left hover:text-ink" onClick={() => toggleSort('name')} aria-sort={sort === 'name' ? (ascending ? 'ascending' : 'descending') : 'none'}>
                Name {sort === 'name' ? <SortIcon className="h-3 w-3" aria-hidden /> : null}
              </button>
              <button className="hidden w-20 items-center justify-end gap-1 hover:text-ink md:flex" onClick={() => toggleSort('size')} aria-sort={sort === 'size' ? (ascending ? 'ascending' : 'descending') : 'none'}>
                Size {sort === 'size' ? <SortIcon className="h-3 w-3" aria-hidden /> : null}
              </button>
              <button className="hidden w-28 items-center gap-1 hover:text-ink md:flex" onClick={() => toggleSort('date')} aria-sort={sort === 'date' ? (ascending ? 'ascending' : 'descending') : 'none'}>
                Added {sort === 'date' ? <SortIcon className="h-3 w-3" aria-hidden /> : null}
              </button>
              <span className="w-[168px]" />
            </div>
            <ul className="divide-y divide-line">
              {visible.map((doc) => (
                <li key={doc.id} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-slate-50/70">
                  <FileGlyph filename={doc.filename} mimeType={doc.mimeType} />
                  <div className="min-w-0 flex-1">
                    <button
                      className="block max-w-full truncate text-left text-sm font-medium hover:text-brand-700"
                      onClick={() => (PREVIEWABLE.has(doc.mimeType) ? setPreviewFor(doc) : setShareFor(doc))}
                      title={doc.filename}
                    >
                      {doc.filename}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      <span className="truncate">{doc.uploadedByEmail}</span>
                      <LinkChip doc={doc} />
                      {doc.links?.lastAccessedAt ? <span className="text-ink-subtle">last opened {timeAgo(doc.links.lastAccessedAt)}</span> : null}
                    </div>
                  </div>
                  <span className="hidden w-20 text-right text-sm tabular-nums text-ink-muted md:block">{formatBytes(doc.size)}</span>
                  <span className="hidden w-28 text-sm text-ink-muted md:block">{formatDate(doc.createdAt)}</span>
                  <div className="flex w-[168px] justify-end"><Actions doc={doc} /></div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {shareFor ? <SharePanel document={shareFor} onClose={() => setShareFor(null)} onChanged={() => void load()} /> : null}
      {previewFor ? <PreviewModal document={previewFor} onClose={() => setPreviewFor(null)} /> : null}
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
