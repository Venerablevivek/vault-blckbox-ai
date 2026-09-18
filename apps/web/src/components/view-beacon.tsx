'use client';

import { useEffect } from 'react';

/**
 * Counts one page view of a share link, from the recipient's browser.
 *
 * The page itself is rendered on the web server, where the only address available is the
 * web container's — counting there made every visitor look like the same person. This
 * request goes through the web proxy carrying the visitor's real address, and link-preview
 * bots (Slack, LinkedIn, WhatsApp…) never send it because they do not run JavaScript.
 * The API ignores repeat views by the same visitor within 30 minutes.
 */
export function ViewBeacon({ token, kind = 'shares' }: { token: string; kind?: 'shares' | 'folder-shares' }) {
  useEffect(() => {
    // Moving around inside a shared folder and back to its top is one visit, not several:
    // count a folder link once per browser session. (Document links are de-duplicated by the API.)
    if (kind === 'folder-shares') {
      const key = `vault:viewed:${token}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
      } catch {
        // Storage unavailable (private mode, blocked): count every open rather than none.
      }
    }
    void fetch(`/api/${kind}/${encodeURIComponent(token)}/view`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => {
      // Telemetry only. A failure must never affect the recipient.
    });
  }, [token, kind]);

  return null;
}
