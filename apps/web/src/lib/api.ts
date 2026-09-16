/**
 * Browser-side API client.
 *
 * Requests go to the web origin and are proxied to the API by a Next.js rewrite, so the
 * session cookie is sent automatically and there is no token handling in the client at all.
 */
export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error: ApiError = payload.error ?? { code: 'UNKNOWN', message: 'Request failed.' };
    throw new ApiRequestError(response.status, error.code, error.message);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, file: File, onProgress?: (percent: number) => void) =>
    new Promise<T>((resolve, reject) => {
      // XMLHttpRequest rather than fetch: fetch still has no upload progress events, and
      // a 25 MB file on a slow connection needs a progress bar rather than a frozen button.
      const form = new FormData();
      form.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.withCredentials = true;

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });

      xhr.addEventListener('load', () => {
        const payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        if (xhr.status >= 200 && xhr.status < 300) return resolve(payload as T);
        const error: ApiError = payload.error ?? { code: 'UNKNOWN', message: 'Upload failed.' };
        reject(new ApiRequestError(xhr.status, error.code, error.message));
      });
      xhr.addEventListener('error', () =>
        reject(new ApiRequestError(0, 'NETWORK', 'Network error during upload.')),
      );

      xhr.send(form);
    }),
};

export interface Workspace {
  id: string;
  name: string;
  role: 'OWNER' | 'MEMBER';
}

export interface DocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  uploadedByEmail?: string;
  createdAt: string;
  /** Rollup of this document's live share links. */
  links?: { count: number; opens: number; lastAccessedAt: string | null };
}

export interface ShareActivity {
  /** Page views, one per visitor per 30 minutes. */
  opens: number;
  downloads: number;
  /** An estimate: NAT merges viewers, network hopping splits them. Labelled as such. */
  distinctViewers: number;
  firstAccessedAt: string | null;
  lastAccessedAt: string | null;
  blockedAttempts: number;
}

export interface ShareSummary {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  activity: ShareActivity;
}

export interface ShareEvent {
  accessedAt: string;
  outcome: 'resolved' | 'downloaded' | 'expired' | 'revoked' | 'document_deleted';
  userAgent: string | null;
  /** Opaque, stable marker for "the same viewer". Never an address. */
  viewer: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "4 minutes ago" reads better than a timestamp for recent activity. */
export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 60) return formatter.format(-seconds, 'second');
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 604800) return formatter.format(-Math.floor(seconds / 86400), 'day');
  void units;
  return formatDate(iso);
}

/** How long until a link dies, phrased for a human. */
export function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}
