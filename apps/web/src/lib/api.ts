import type { components } from './api-schema';

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
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
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
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }),
};

/**
 * Response types come from the API's OpenAPI document (`npm run api:types` regenerates
 * api-schema.d.ts from apps/api/openapi.json), so a change to an API response is a compile
 * error here rather than a surprise at runtime.
 */
export type Schemas = components['schemas'];

export type Role = Schemas['Role'];
export type Workspace = Schemas['WorkspaceSummary'];
export type FolderDto = Schemas['Folder'];
export type DocumentDto = Schemas['Document'];
export type DocumentListResponse = Schemas['DocumentList'];
export type BulkResult = Schemas['BulkDocumentsResult'];
export type ArchiveSummary = Schemas['ArchiveSummary'];
export type ShareActivity = Schemas['ShareActivity'];
export type ShareSummary = Schemas['ShareSummary'];
export type ShareOutcome = Schemas['ShareOutcome'];
export type FolderShareSummary = Schemas['FolderShareSummary'];
export type DocumentVersion = Schemas['DocumentVersion'];
export type DocumentComment = Schemas['DocumentComment'];
export interface ShareEvent {
  accessedAt: string;
  outcome: ShareOutcome;
  userAgent: string | null;
  /** Opaque, stable marker for "the same viewer". Never an address. */
  viewer: string;
  /** The address the viewer proved, on a link restricted to named people. */
  email: string | null;
}
export type Overview = Schemas['Overview'];
export type AuditEvent = Schemas['AuditEvent'];
export type NotificationDto = Schemas['Notification'];
export type Member = Schemas['Member'];
export type PendingInvitation = Schemas['PendingInvitation'];
export type Session = Schemas['Session'];
export type StorageUsage = Schemas['StorageUsage'];

/** Owners and members contribute; viewers only read. Mirrors the API's policy.ts. */
export const canContribute = (role: Role): boolean => role === 'OWNER' || role === 'MEMBER';
export const ownsOrAdministers = (role: Role, createdBy: string | null, userId: string): boolean =>
  role === 'OWNER' || (role === 'MEMBER' && createdBy === userId);

/**
 * A post-sign-in destination is only followed if it is a path on this site. `//evil.com` and
 * `https://evil.com` are URLs to other sites, and `/\evil.com` is treated as one by browsers.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
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
