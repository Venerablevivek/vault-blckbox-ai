'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, Home } from 'lucide-react';
import { api, ApiRequestError, type FolderDto } from '@/lib/api';
import { Modal } from './dialog';
import { ErrorNote } from './ui';

/**
 * Picks a destination folder by browsing the workspace tree one level at a time.
 *
 * `excludeId` hides a folder being moved (and so everything beneath it) from the choices. The
 * API still rejects a move into a folder's own subtree; this just keeps the obviously invalid
 * option out of the way.
 */
export function FolderPicker({
  workspaceId,
  title,
  confirmLabel,
  currentFolderId,
  excludeId,
  onPick,
  onClose,
}: {
  workspaceId: string;
  title: string;
  confirmLabel: string;
  currentFolderId: string | null;
  excludeId?: string;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const [parentId, setParentId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [path, setPath] = useState<FolderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    setLoading(true);
    try {
      const data = await api.get<{ folders: FolderDto[]; path: FolderDto[] }>(
        `/api/workspaces/${workspaceId}/folders${id ? `?parentId=${id}` : ''}`,
      );
      setFolders(data.folders.filter((f) => f.id !== excludeId));
      setPath(data.path);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load folders.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, excludeId]);

  useEffect(() => {
    void load(parentId);
  }, [load, parentId]);

  const here = parentId === currentFolderId;

  return (
    <Modal open onClose={onClose} title={title} size="md">
      {error ? <ErrorNote message={error} /> : null}

      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <button className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-ink-muted hover:bg-slate-100 hover:text-ink" onClick={() => setParentId(null)}>
          <Home className="h-3.5 w-3.5" aria-hidden /> Workspace
        </button>
        {path.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-ink-subtle" aria-hidden />
            <button className="rounded px-1.5 py-1 text-ink-muted hover:bg-slate-100 hover:text-ink" onClick={() => setParentId(f.id)}>
              {f.name}
            </button>
          </span>
        ))}
      </nav>

      <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {loading ? (
          <li className="px-4 py-6 text-center text-sm text-ink-muted">Loading…</li>
        ) : folders.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-ink-muted">No subfolders here.</li>
        ) : (
          folders.map((f) => (
            <li key={f.id}>
              <button
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
                onClick={() => setParentId(f.id)}
              >
                <Folder className="h-4 w-4 text-brand-600" aria-hidden />
                <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight className="h-4 w-4 text-ink-subtle" aria-hidden />
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="truncate text-xs text-ink-muted">
          Destination: <span className="font-medium text-ink">{path.length ? path[path.length - 1]!.name : 'Workspace root'}</span>
        </p>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onPick(parentId)} disabled={here} title={here ? 'Already here' : undefined}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
