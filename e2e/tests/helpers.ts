import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { resetRateLimits } from '../global-setup';

export const PASSWORD = 'correct-horse-battery';

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}@e2e.test`;
}

/** Fails the test if the page ever opens a native alert/confirm/prompt box. */
export function forbidNativeDialogs(page: Page): void {
  page.on('dialog', async (dialog) => {
    await dialog.dismiss();
    throw new Error(`Native ${dialog.type()} dialog opened: "${dialog.message()}"`);
  });
}

/**
 * Opens a workspace's documents page and waits until the list has loaded from the API. That only
 * happens after hydration, so file inputs and buttons are live: setting files on a page that has
 * not hydrated yet does nothing.
 */
export async function openDocuments(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}/documents`);
  await expect(
    page.getByText('No documents yet').or(page.getByRole('button', { name: 'More actions' }).first()),
  ).toBeVisible();
}

/** Registers through the API (sets the session cookie on this request context). */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MailpitSummary {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
}

/** Waits for Mailpit to receive a message for `to` whose subject contains `subject`; returns its text. */
export async function waitForEmail(request: APIRequestContext, to: string, subject: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const list = (await (await request.get(`${MAILPIT}/api/v1/messages`)).json()) as { messages: MailpitSummary[] };
    const found = list.messages.find((m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject));
    if (found)
      return ((await (await request.get(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as { Text: string }).Text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}

/** Follows the confirmation link from the verification email, as the person would. */
export async function confirmEmail(request: APIRequestContext, email: string): Promise<void> {
  const text = await waitForEmail(request, email, 'Confirm your email address');
  const token = /verify-email#token=(evt_[\w-]+)/.exec(text)![1]!;
  const response = await request.post('/api/auth/email/verify', { data: { token } });
  expect(response.status(), await response.text()).toBe(204);
}

/**
 * Registers through the API (sets the session cookie on this request context) and confirms the
 * address, unless `confirm` is false. Joining with an invitation verifies it already.
 */
export async function registerViaApi(
  request: APIRequestContext,
  email: string,
  inviteToken?: string,
  confirm = true,
): Promise<void> {
  const data = { email, password: PASSWORD, ...(inviteToken ? { inviteToken } : {}) };
  let response = await request.post('/api/auth/register', { data });
  // The suite registers more accounts than the 10-per-hour limit allows one address. Registration
  // isn't what these tests are about, so clear the counters and retry (see global-setup.ts).
  if (response.status() === 429 && process.env.E2E_RESET_RATE_LIMITS !== 'false') {
    resetRateLimits();
    response = await request.post('/api/auth/register', { data });
  }
  expect(response.status(), await response.text()).toBe(201);
  if (confirm && !inviteToken) await confirmEmail(request, email);
}

export async function firstWorkspaceId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/workspaces');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { workspaces: { id: string }[] };
  return body.workspaces[0]!.id;
}

export async function uploadText(request: APIRequestContext, workspaceId: string, name: string): Promise<string> {
  const response = await request.post(`/api/workspaces/${workspaceId}/documents`, {
    multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(`hello from ${name}\n`) } },
  });
  expect(response.status(), await response.text()).toBe(201);
  const document = ((await response.json()) as { document: { id: string; scanStatus: string } }).document;
  // When the stack scans uploads, a file can't be shared or downloaded until it's scanned.
  if (document.scanStatus === 'pending') {
    await expect
      .poll(
        async () => {
          const listing = (await (
            await request.get(`/api/workspaces/${workspaceId}/documents?q=${encodeURIComponent(name)}`)
          ).json()) as {
            documents: Array<{ id: string; scanStatus: string }>;
          };
          return listing.documents.find((d) => d.id === document.id)?.scanStatus;
        },
        { timeout: 30_000 },
      )
      .not.toBe('pending');
  }
  return document.id;
}

/** A small valid one-page PDF containing `text`, built by hand (no PDF library needed here). */
export function simplePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
