import { api, ApiRequestError, type Schemas } from './api';

type Upload = Schemas['Upload'];
type UploadResult = Schemas['UploadResult'];

/** Parts sent at once. Browsers allow about six connections per host; leave room for the app. */
const CONCURRENCY = 4;
/** Signed URLs requested per call. */
const SIGN_BATCH = 20;
const PART_ATTEMPTS = 3;

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled');
  }
}

/**
 * Uploads a file straight to object storage in parts, in parallel, and resumes after a failure,
 * a closed tab or a lost connection: re-selecting the same file continues from the parts storage
 * already has. The API only opens, signs and completes the upload; file bytes never pass through it.
 */
export async function directUpload(input: {
  workspaceId: string;
  folderId: string | null;
  file: File;
  onProgress: (percent: number) => void;
  signal: AbortSignal;
}): Promise<UploadResult> {
  const { workspaceId, folderId, file, onProgress, signal } = input;
  const resumeKey = `vault-upload:${workspaceId}:${folderId ?? 'root'}:${file.name}:${file.size}:${file.lastModified}`;

  const { upload, received } = await openOrResume();
  // Cancel can be pressed while the upload is still being opened, before its id is known to the
  // page. Once it exists, the upload cancels itself, so its reserved storage is always released.
  const cancelled = async () => {
    forget();
    await api.del(`/api/uploads/${upload.id}`).catch(() => undefined);
    return new UploadCancelled();
  };
  if (signal.aborted) throw await cancelled();
  const done = new Map<number, number>(received);
  const inFlight = new Map<number, number>();
  const report = () => {
    let bytes = 0;
    for (const size of done.values()) bytes += size;
    for (const size of inFlight.values()) bytes += size;
    onProgress(Math.min(99, Math.floor((bytes / file.size) * 100)));
  };
  report();

  const queue = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  const urls = new Map<number, string>();
  /** Parts being signed right now, so parallel workers share one request instead of each sending their own. */
  const signing = new Map<number, Promise<void>>();

  async function urlFor(partNumber: number, refresh = false): Promise<string> {
    if (refresh) urls.delete(partNumber);
    if (!urls.has(partNumber) && !signing.has(partNumber)) {
      // Sign this part and the next few waiting ones together.
      const batch = [partNumber, ...queue.filter((n) => !urls.has(n) && !signing.has(n)).slice(0, SIGN_BATCH - 1)];
      const request = api
        .post<Schemas['SignedParts']>(`/api/uploads/${upload.id}/parts`, { partNumbers: batch })
        .then((signed) => {
          for (const part of signed.parts) urls.set(part.partNumber, part.url);
        })
        .finally(() => batch.forEach((n) => signing.delete(n)));
      batch.forEach((n) => signing.set(n, request));
    }
    await signing.get(partNumber);
    const url = urls.get(partNumber);
    if (!url) throw new Error('could not sign upload part');
    return url;
  }

  async function sendPart(partNumber: number): Promise<void> {
    const start = (partNumber - 1) * upload.partSize;
    const blob = file.slice(start, Math.min(file.size, start + upload.partSize));
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new UploadCancelled();
      try {
        await putPart(await urlFor(partNumber, attempt > 1), blob, signal, (loaded) => {
          inFlight.set(partNumber, loaded);
          report();
        });
        inFlight.delete(partNumber);
        done.set(partNumber, blob.size);
        report();
        return;
      } catch (error) {
        inFlight.delete(partNumber);
        if (error instanceof UploadCancelled || attempt >= PART_ATTEMPTS) throw error;
        // Expired URL, network blip or a storage 5xx: wait, then retry with a fresh URL.
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await sendPart(next);
  });
  try {
    await Promise.all(workers);
  } catch (error) {
    queue.length = 0;
    if (error instanceof UploadCancelled || signal.aborted) throw await cancelled();
    throw error;
  }
  if (signal.aborted) throw await cancelled();

  const result = await api.post<UploadResult>(`/api/uploads/${upload.id}/complete`);
  forget();
  onProgress(100);
  return result;

  async function openOrResume(): Promise<{ upload: Upload; received: Array<[number, number]> }> {
    const saved = read();
    if (saved) {
      try {
        const status = await api.get<Schemas['UploadStatus']>(`/api/uploads/${saved}`);
        if (status.upload.status === 'pending' && status.upload.size === file.size) {
          return { upload: status.upload, received: status.uploadedParts.map((p) => [p.partNumber, p.size]) };
        }
      } catch (error) {
        if (!(error instanceof ApiRequestError)) throw error;
      }
      forget();
    }
    const created = await api.post<Schemas['UploadCreated']>(`/api/workspaces/${workspaceId}/uploads`, {
      filename: file.name,
      size: file.size,
      // Browsers leave the type empty for unfamiliar extensions; the server checks the real bytes anyway.
      mimeType: file.type || guessType(file.name),
      folderId,
    });
    write(created.upload.id);
    return { upload: created.upload, received: [] };
  }

  function read(): string | null {
    try {
      return localStorage.getItem(resumeKey);
    } catch {
      return null;
    }
  }
  function write(uploadId: string): void {
    try {
      localStorage.setItem(resumeKey, uploadId);
    } catch {
      // Private mode: the upload still works, it just can't resume after a reload.
    }
  }
  function forget(): void {
    try {
      localStorage.removeItem(resumeKey);
    } catch {
      // ignore
    }
  }
}

/** Cancels the in-progress upload for this file, if any, releasing its reserved storage. */
export async function cancelDirectUpload(workspaceId: string, folderId: string | null, file: File): Promise<void> {
  const key = `vault-upload:${workspaceId}:${folderId ?? 'root'}:${file.name}:${file.size}:${file.lastModified}`;
  let uploadId: string | null = null;
  try {
    uploadId = localStorage.getItem(key);
    localStorage.removeItem(key);
  } catch {
    return;
  }
  if (uploadId) await api.del(`/api/uploads/${uploadId}`).catch(() => undefined);
}

function putPart(url: string, blob: Blob, signal: AbortSignal, onLoaded: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // XMLHttpRequest for upload progress, which fetch doesn't provide.
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.addEventListener('progress', (event) => onLoaded(event.loaded));
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`storage responded ${xhr.status}`)),
    );
    xhr.addEventListener('error', () => reject(new Error('network error')));
    xhr.addEventListener('abort', () => reject(new UploadCancelled()));
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.addEventListener('loadend', () => signal.removeEventListener('abort', onAbort));
    xhr.send(blob);
  });
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessType(filename: string): string {
  return EXTENSION_TYPES[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
