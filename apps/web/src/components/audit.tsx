import {
  Download,
  Eye,
  FilePen,
  FilePlus2,
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

export type AuditAction =
  | 'workspace.created'
  | 'workspace.renamed'
  | 'document.uploaded'
  | 'document.downloaded'
  | 'document.previewed'
  | 'document.renamed'
  | 'document.deleted'
  | 'share.created'
  | 'share.revoked'
  | 'share.accessed'
  | 'share.blocked'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'member.role_changed'
  | 'invitation.revoked';

export interface AuditEvent {
  id: string;
  actorEmail: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

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
};

export function describeAuditEvent(event: AuditEvent): string {
  const who = event.actorEmail ?? 'Someone with the link';
  const m = event.metadata;
  const file = (m.filename as string) ?? 'a document';
  const email = (m.email as string) ?? 'someone';
  const role = (r: unknown) => (r === 'OWNER' ? 'owner' : 'member');

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
    case 'member.role_changed': return `${who} made ${email} ${role(m.to) === 'owner' ? 'an owner' : 'a member'}`;
    case 'invitation.revoked': return `${who} cancelled the invitation for ${email}`;
    default: return event.action;
  }
}
