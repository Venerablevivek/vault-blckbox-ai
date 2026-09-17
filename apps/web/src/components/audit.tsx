import {
  Download,
  Eye,
  ArchiveRestore,
  FileX2,
  FilePen,
  FilePlus2,
  FolderInput,
  FolderMinus,
  FolderPen,
  FolderPlus,
  Settings2,
  Link2,
  Link2Off,
  LogOut,
  Mail,
  MailX,
  Pencil,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserCheck,
  UserCog,
  UserMinus,
  type LucideIcon,
} from 'lucide-react';
import type { AuditEvent } from '@/lib/api';

export type { AuditEvent };
export type AuditAction = AuditEvent['action'];

/** Icon and tint per action, so the feed is scannable without reading every line. */
export const AUDIT_STYLE: Record<AuditAction, { icon: LucideIcon; tone: string }> = {
  'workspace.created': { icon: Sparkles, tone: 'bg-brand-50 text-brand-600' },
  'workspace.renamed': { icon: Pencil, tone: 'bg-slate-100 text-ink-muted' },
  'document.uploaded': { icon: FilePlus2, tone: 'bg-brand-50 text-brand-600' },
  'document.downloaded': { icon: Download, tone: 'bg-sky-50 text-sky-600' },
  'document.previewed': { icon: Eye, tone: 'bg-sky-50 text-sky-600' },
  'document.renamed': { icon: FilePen, tone: 'bg-slate-100 text-ink-muted' },
  'document.deleted': { icon: Trash2, tone: 'bg-danger-soft text-danger' },
  'share.created': { icon: Link2, tone: 'bg-violet-50 text-violet-600' },
  'share.revoked': { icon: Link2Off, tone: 'bg-danger-soft text-danger' },
  'share.accessed': { icon: Eye, tone: 'bg-ok-soft text-ok' },
  'share.blocked': { icon: ShieldAlert, tone: 'bg-warn-soft text-warn' },
  'member.invited': { icon: Mail, tone: 'bg-slate-100 text-ink-muted' },
  'member.joined': { icon: UserCheck, tone: 'bg-ok-soft text-ok' },
  'member.removed': { icon: UserMinus, tone: 'bg-danger-soft text-danger' },
  'member.left': { icon: LogOut, tone: 'bg-slate-100 text-ink-muted' },
  'member.role_changed': { icon: UserCog, tone: 'bg-violet-50 text-violet-600' },
  'invitation.revoked': { icon: MailX, tone: 'bg-danger-soft text-danger' },
  'document.moved': { icon: FolderInput, tone: 'bg-slate-100 text-ink-muted' },
  'document.trashed': { icon: Trash2, tone: 'bg-warn-soft text-warn' },
  'document.restored': { icon: ArchiveRestore, tone: 'bg-ok-soft text-ok' },
  'document.purged': { icon: FileX2, tone: 'bg-danger-soft text-danger' },
  'folder.created': { icon: FolderPlus, tone: 'bg-brand-50 text-brand-600' },
  'folder.renamed': { icon: FolderPen, tone: 'bg-slate-100 text-ink-muted' },
  'folder.moved': { icon: FolderInput, tone: 'bg-slate-100 text-ink-muted' },
  'folder.deleted': { icon: FolderMinus, tone: 'bg-danger-soft text-danger' },
  'share.updated': { icon: Settings2, tone: 'bg-violet-50 text-violet-600' },
};

export function describeAuditEvent(event: AuditEvent): string {
  const who = event.actorEmail ?? (event.action === 'document.purged' ? 'The system' : 'Someone with the link');
  const m = event.metadata;
  const file = (m.filename as string) ?? 'a document';
  const email = (m.email as string) ?? 'someone';
  const folder = (m.name as string) ?? 'a folder';
  const role = (r: unknown) => (r === 'OWNER' ? 'an owner' : r === 'VIEWER' ? 'a viewer' : 'a member');

  switch (event.action) {
    case 'workspace.created': return `${who} created this workspace`;
    case 'workspace.renamed': return `${who} renamed the workspace to “${m.to as string}”`;
    case 'document.uploaded': return `${who} uploaded ${file}`;
    case 'document.downloaded': return `${who} downloaded ${file}`;
    case 'document.previewed': return `${who} previewed ${file}`;
    case 'document.renamed': return `${who} renamed ${m.from as string} to ${m.to as string}`;
    case 'document.deleted': return `${who} deleted ${file}`;
    case 'share.created': return `${who} created a share link for ${file}`;
    case 'share.revoked': return `${who} revoked a share link`;
    case 'share.accessed': return `${file} was opened through a share link`;
    case 'share.blocked': return `A share link for ${file} was used after it stopped working`;
    case 'member.invited': return `${who} invited ${email}`;
    case 'member.joined': return `${email} joined the workspace`;
    case 'member.removed': return `${who} removed ${email}`;
    case 'member.left': return `${email} left the workspace`;
    case 'member.role_changed': return `${who} made ${email} ${role(m.to)}`;
    case 'invitation.revoked': return `${who} cancelled the invitation for ${email}`;
    case 'document.moved': return `${who} moved ${file}`;
    case 'document.trashed': return `${who} moved ${file} to the trash`;
    case 'document.restored': return `${who} restored ${file} from the trash`;
    case 'document.purged':
      return m.reason === 'retention' ? `${file} was deleted forever after 30 days in the trash` : `${who} deleted ${file} forever`;
    case 'folder.created': return `${who} created the folder ${folder}`;
    case 'folder.renamed': return `${who} renamed the folder ${m.from as string} to ${m.to as string}`;
    case 'folder.moved': return `${who} moved the folder ${folder}`;
    case 'folder.deleted': return `${who} deleted the folder ${folder}`;
    case 'share.updated': return `${who} changed a share link's settings`;
    default: return event.action;
  }
}
