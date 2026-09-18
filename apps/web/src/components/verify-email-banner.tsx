'use client';

import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api';
import { toast } from './toast';

/**
 * Shown until the account confirms its email address. Uploading and viewing work meanwhile;
 * sharing and inviting wait for confirmation, so the banner says so.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [sending, setSending] = useState(false);

  async function resend() {
    setSending(true);
    try {
      await api.post('/api/auth/email/resend');
      toast(`Sent a new confirmation email to ${email}`, 'success');
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Could not send the email.', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/25 bg-warn-soft px-4 py-2.5 text-sm text-warn sm:px-6"
      role="status"
    >
      <MailWarning className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Confirm your email address to share documents and invite people. We sent a link to{' '}
        <span className="font-medium">{email}</span>.
      </span>
      <button className="btn-secondary btn-sm" onClick={() => void resend()} disabled={sending}>
        {sending ? 'Sending…' : 'Resend email'}
      </button>
    </div>
  );
}
