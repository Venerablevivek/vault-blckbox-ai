import type { MailMessage } from './mailer';

/**
 * Transactional email content. Plain and short on purpose: every message says what happened,
 * what to do, and what to do if it wasn't you. Every interpolated value is HTML-escaped,
 * because workspace names and email addresses are user input.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${p}</p>`).join('');
  const button = action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(action.url)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#64748b">Or paste this link into your browser:<br>${escapeHtml(action.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:700;color:#4f46e5">Vault</p>
<h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(heading)}</h1>${body}${button}
</div></body></html>`;
}

export function invitationEmail(input: {
  to: string;
  workspaceName: string;
  inviterEmail: string;
  role: string;
  url: string;
  expiresAt: Date;
}): MailMessage {
  const subject = `${input.inviterEmail} invited you to ${input.workspaceName} on Vault`;
  const role = input.role.toLowerCase();
  return {
    to: input.to,
    subject,
    text: [
      `${input.inviterEmail} invited you to join the workspace "${input.workspaceName}" as a ${role}.`,
      '',
      `Accept the invitation: ${input.url}`,
      '',
      `The link works once, only for ${input.to}, and expires on ${input.expiresAt.toUTCString()}.`,
      "If you weren't expecting this, you can ignore this email.",
    ].join('\n'),
    html: layout(
      `You're invited to ${input.workspaceName}`,
      [
        `${escapeHtml(input.inviterEmail)} invited you to join <strong>${escapeHtml(input.workspaceName)}</strong> as a ${escapeHtml(role)}.`,
        `The link works once, only for ${escapeHtml(input.to)}, and expires on ${escapeHtml(input.expiresAt.toUTCString())}.`,
      ],
      { label: 'Accept invitation', url: input.url },
    ),
  };
}

export function passwordResetEmail(input: { to: string; url: string; ttlMinutes: number }): MailMessage {
  return {
    to: input.to,
    subject: 'Reset your Vault password',
    text: [
      'Someone asked to reset the password for this Vault account.',
      '',
      `Choose a new password: ${input.url}`,
      '',
      `The link works once and expires in ${input.ttlMinutes} minutes. Resetting signs you out everywhere.`,
      "If you didn't ask for this, ignore this email; your password stays the same.",
    ].join('\n'),
    html: layout(
      'Reset your password',
      [
        'Someone asked to reset the password for this Vault account.',
        `The link works once and expires in ${input.ttlMinutes} minutes. Resetting signs you out everywhere.`,
        "If you didn't ask for this, ignore this email; your password stays the same.",
      ],
      { label: 'Choose a new password', url: input.url },
    ),
  };
}

export function passwordChangedEmail(input: { to: string; webUrl: string; via: 'reset' | 'settings' }): MailMessage {
  const how = input.via === 'reset' ? 'using a reset link' : 'from your account settings';
  return {
    to: input.to,
    subject: 'Your Vault password was changed',
    text: [
      `The password for your Vault account was changed ${how}.`,
      '',
      "If this was you, there's nothing to do.",
      `If it wasn't, reset your password now: ${input.webUrl}/forgot-password`,
    ].join('\n'),
    html: layout(
      'Your password was changed',
      [
        `The password for your Vault account was changed ${escapeHtml(how)}.`,
        "If this was you, there's nothing to do. If it wasn't, reset your password now.",
      ],
      { label: 'Reset password', url: `${input.webUrl}/forgot-password` },
    ),
  };
}

export function verificationEmail(input: { to: string; url: string; ttlHours: number }): MailMessage {
  return {
    to: input.to,
    subject: 'Confirm your email address for Vault',
    text: [
      'Confirm this is your email address to finish setting up your Vault account.',
      '',
      `Confirm: ${input.url}`,
      '',
      `The link works once and expires in ${input.ttlHours} hours. Until you confirm, you can upload and view documents, but not share them or invite people.`,
      "If you didn't create a Vault account, you can ignore this email.",
    ].join('\n'),
    html: layout(
      'Confirm your email address',
      [
        'Confirm this is your email address to finish setting up your Vault account.',
        `The link works once and expires in ${input.ttlHours} hours. Until you confirm, you can upload and view documents, but not share them or invite people.`,
        "If you didn't create a Vault account, you can ignore this email.",
      ],
      { label: 'Confirm email address', url: input.url },
    ),
  };
}

export function shareCodeEmail(input: { to: string; code: string; ttlMinutes: number }): MailMessage {
  return {
    to: input.to,
    subject: `${input.code} is your code to open a shared file`,
    text: [
      'Someone shared a file with you on Vault. Enter this code to open it:',
      '',
      input.code,
      '',
      `The code works once and expires in ${input.ttlMinutes} minutes.`,
      "If you didn't ask for it, you can ignore this email: nobody can open the file without the code.",
    ].join('\n'),
    html: layout('Your code to open a shared file', [
      'Someone shared a file with you on Vault. Enter this code to open it:',
      `<span style="font-size:28px;font-weight:700;letter-spacing:6px">${escapeHtml(input.code)}</span>`,
      `The code works once and expires in ${input.ttlMinutes} minutes.`,
      "If you didn't ask for it, you can ignore this email: nobody can open the file without the code.",
    ]),
  };
}

export function notificationEmail(input: { to: string; title: string; body: string | null; url: string }): MailMessage {
  return {
    to: input.to,
    subject: input.title,
    text: [
      input.title,
      ...(input.body ? ['', input.body] : []),
      '',
      `Open Vault: ${input.url}`,
      '',
      UNSUBSCRIBE_TEXT,
    ].join('\n'),
    html: layout(input.title, [...(input.body ? [escapeHtml(input.body)] : []), escapeHtml(UNSUBSCRIBE_TEXT)], {
      label: 'Open Vault',
      url: input.url,
    }),
  };
}

export function digestEmail(input: {
  to: string;
  frequency: 'daily' | 'weekly';
  items: Array<{ title: string; workspace: string | null; at: Date }>;
  total: number;
  url: string;
}): MailMessage {
  const period = input.frequency === 'daily' ? 'today' : 'this week';
  const heading = `${input.total} unread notification${input.total === 1 ? '' : 's'} ${period}`;
  const more = input.total > input.items.length ? `…and ${input.total - input.items.length} more.` : null;
  const line = (item: (typeof input.items)[number]) => `${item.title}${item.workspace ? ` (${item.workspace})` : ''}`;
  return {
    to: input.to,
    subject: `Vault: ${heading}`,
    text: [
      heading,
      '',
      ...input.items.map((item) => `- ${line(item)}`),
      ...(more ? [more] : []),
      '',
      `Open Vault: ${input.url}`,
      '',
      UNSUBSCRIBE_TEXT,
    ].join('\n'),
    html: layout(
      heading,
      [
        `<ul style="margin:0;padding-left:18px">${input.items.map((item) => `<li style="margin:0 0 6px">${escapeHtml(line(item))}</li>`).join('')}</ul>`,
        ...(more ? [escapeHtml(more)] : []),
        escapeHtml(UNSUBSCRIBE_TEXT),
      ],
      { label: 'Open Vault', url: input.url },
    ),
  };
}

const UNSUBSCRIBE_TEXT =
  'You get this email because of your notification settings. Change them on your account page in Vault.';
