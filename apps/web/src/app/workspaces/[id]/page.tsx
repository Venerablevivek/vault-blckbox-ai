'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Eye,
  FileText,
  HardDrive,
  History,
  Link2,
  Mail,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiRequestError, formatBytes, timeAgo } from '@/lib/api';
import { DailyBars, StorageBreakdown } from '@/components/charts';
import { EmptyState, ErrorNote, FileGlyph, Shell, useSession } from '@/components/ui';
import { describeAuditEvent, AUDIT_STYLE, type AuditEvent } from '@/components/audit';

interface Overview {
  role: 'OWNER' | 'MEMBER';
  totals: { documents: number; bytes: number; members: number; liveLinks: number; opens: number; pendingInvites: number };
  storageByType: Array<{ category: string; count: number; bytes: number }>;
  series: Array<{ day: string; uploads: number; opens: number }>;
  topShared: Array<{ id: string; filename: string; mimeType: string; opens: number; viewers: number; lastAccessedAt: string | null }>;
  recentDocuments: Array<{ id: string; filename: string; mimeType: string; size: number; createdAt: string; uploadedByEmail: string }>;
  recentActivity: AuditEvent[] | null;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** A stat tile: sentence-case label, value in ink, icon as decoration only. */
function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  hint?: string;
  tone: string;
}) {
  return (
    <div className="card flex items-start gap-3.5 p-4">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`} aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-ink-muted">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold leading-tight tracking-tight">{value}</p>
        {hint ? <p className="mt-0.5 truncate text-[11px] text-ink-subtle">{hint}</p> : null}
      </div>
    </div>
  );
}

export default function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = use(params);
  const session = useSession(workspaceId);

  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Overview>(`/api/workspaces/${workspaceId}/overview`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return;
      setError(err instanceof ApiRequestError ? err.message : 'Failed to load the dashboard.');
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const workspace = session.workspaces.find((w) => w.id === workspaceId);
  const isOwner = data?.role === 'OWNER';
  const firstName = session.email.split('@')[0] ?? '';

  return (
    <Shell
      workspaces={session.workspaces}
      activeId={workspaceId}
      email={session.email}
      title="Overview"
      subtitle={workspace?.name}
      actions={
        <Link href={`/workspaces/${workspaceId}/documents?upload=1`} className="btn-primary">
          <Upload className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Upload</span>
        </Link>
      }
    >
      <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        {error ? <ErrorNote message={error} /> : null}

        {/* Welcome banner */}
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-indigo-600 to-violet-600 p-6 text-white shadow-lift sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/10 blur-2xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-24 right-40 h-56 w-56 rounded-full bg-sky-400/20 blur-2xl" aria-hidden />
          <div className="relative flex flex-wrap items-end justify-between gap-5">
            <div>
              <p className="text-sm text-brand-100">{greeting()}, {firstName}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{workspace?.name ?? 'Your workspace'}</h2>
              <p className="mt-2 max-w-xl text-sm text-brand-100">
                {data
                  ? `${data.totals.documents} documents · ${data.totals.members} member${data.totals.members === 1 ? '' : 's'} · ${data.totals.liveLinks} live share link${data.totals.liveLinks === 1 ? '' : 's'}`
                  : 'Loading your workspace…'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/workspaces/${workspaceId}/documents?upload=1`} className="btn h-10 bg-white text-brand-700 hover:bg-brand-50">
                <Upload className="h-4 w-4" aria-hidden /> Upload file
              </Link>
              {isOwner ? (
                <Link href={`/workspaces/${workspaceId}/members`} className="btn h-10 bg-white/15 text-white ring-1 ring-white/30 hover:bg-white/25">
                  <UserPlus className="h-4 w-4" aria-hidden /> Invite
                </Link>
              ) : null}
            </div>
          </div>
        </section>

        {/* Stat tiles */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" aria-label="Workspace totals">
          <Tile icon={FileText} label="Documents" value={data?.totals.documents ?? '—'} tone="bg-brand-50 text-brand-600" />
          <Tile icon={HardDrive} label="Storage used" value={data ? formatBytes(data.totals.bytes) : '—'} tone="bg-sky-50 text-sky-600" />
          <Tile icon={Users} label="Members" value={data?.totals.members ?? '—'} tone="bg-violet-50 text-violet-600" />
          <Tile icon={Link2} label="Live share links" value={data?.totals.liveLinks ?? '—'} tone="bg-emerald-50 text-emerald-600" />
          <Tile icon={Eye} label="Link opens" value={data?.totals.opens ?? '—'} hint="all time" tone="bg-amber-50 text-amber-600" />
          <Tile icon={Mail} label="Pending invites" value={data?.totals.pendingInvites ?? '—'} tone="bg-rose-50 text-rose-600" />
        </section>

        {/* Activity charts — two single-series charts rather than one dual-scale chart. */}
        <section className="grid gap-4 lg:grid-cols-2">
          <DailyBars
            title="Uploads"
            unit="files"
            color="#4f46e5"
            data={(data?.series ?? []).map((d) => ({ day: d.day, value: d.uploads }))}
          />
          <DailyBars
            title="Share link opens"
            unit="opens"
            color="#1baf7a"
            data={(data?.series ?? []).map((d) => ({ day: d.day, value: d.opens }))}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <StorageBreakdown items={data?.storageByType ?? []} />
          </div>

          <div className="card overflow-hidden lg:col-span-3">
            <div className="flex items-center justify-between px-5 pt-5">
              <div>
                <p className="text-sm font-semibold">Most viewed share links</p>
                <p className="mt-0.5 text-xs text-ink-muted">Documents people outside the team actually opened</p>
              </div>
              <Link href={`/workspaces/${workspaceId}/documents`} className="text-xs font-medium text-brand-600 hover:underline">
                All documents
              </Link>
            </div>
            {data && data.topShared.length === 0 ? (
              <EmptyState icon={Link2} title="No link has been opened yet" hint="Share a document and you'll see who opens it here." />
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {(data?.topShared ?? []).map((doc, index) => {
                  const peak = data?.topShared[0]?.opens ?? 1;
                  return (
                    <li key={doc.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="w-4 text-xs font-semibold text-ink-subtle tabular-nums">{index + 1}</span>
                      <FileGlyph filename={doc.filename} mimeType={doc.mimeType} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{doc.filename}</p>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${(doc.opens / peak) * 100}%` }} />
                        </div>
                      </div>
                      <div className="w-40 shrink-0 text-right">
                        <p className="text-sm font-semibold tabular-nums">{doc.opens} opens</p>
                        <p className="text-[11px] text-ink-muted">~{doc.viewers} viewer{doc.viewers === 1 ? '' : 's'}{doc.lastAccessedAt ? ` · ${timeAgo(doc.lastAccessedAt)}` : ''}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5">
              <p className="text-sm font-semibold">Recently added</p>
              <Link href={`/workspaces/${workspaceId}/documents`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                View all <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
            {data && data.recentDocuments.length === 0 ? (
              <EmptyState title="No documents yet" hint="Upload your first file to get started." />
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {(data?.recentDocuments ?? []).map((doc) => (
                  <li key={doc.id} className="flex items-center gap-3 px-5 py-3">
                    <FileGlyph filename={doc.filename} mimeType={doc.mimeType} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{doc.filename}</p>
                      <p className="truncate text-xs text-ink-muted">{doc.uploadedByEmail} · {formatBytes(doc.size)}</p>
                    </div>
                    <span className="shrink-0 text-xs text-ink-subtle">{timeAgo(doc.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5">
              <p className="text-sm font-semibold">Recent activity</p>
              {isOwner ? (
                <Link href={`/workspaces/${workspaceId}/activity`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                  Full audit trail <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              ) : null}
            </div>
            {data && data.recentActivity === null ? (
              <EmptyState
                icon={History}
                title="Activity is visible to owners"
                hint="The audit trail includes every member's actions and invited addresses, so only workspace owners can see it."
              />
            ) : data && data.recentActivity?.length === 0 ? (
              <EmptyState icon={History} title="Nothing has happened yet" />
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {(data?.recentActivity ?? []).map((event) => {
                  const style = AUDIT_STYLE[event.action];
                  const Icon = style.icon;
                  return (
                    <li key={event.id} className="flex items-center gap-3 px-5 py-3">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.tone}`} aria-hidden>
                        <Icon className="h-4 w-4" />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-sm">{describeAuditEvent(event)}</p>
                      <span className="shrink-0 text-xs text-ink-subtle">{timeAgo(event.createdAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </Shell>
  );
}
