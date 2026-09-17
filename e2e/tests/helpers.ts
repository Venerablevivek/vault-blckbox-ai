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
export async function registerViaApi(request: APIRequestContext, email: string): Promise<void> {
  let response = await request.post('/api/auth/register', { data: { email, password: PASSWORD } });
  // The suite registers more accounts than the 10-per-hour limit allows one address. Registration
  // isn't what these tests are about, so clear the counters and retry (see global-setup.ts).
  if (response.status() === 429 && process.env.E2E_RESET_RATE_LIMITS !== 'false') {
    resetRateLimits();
    response = await request.post('/api/auth/register', { data: { email, password: PASSWORD } });
  }
  expect(response.status(), await response.text()).toBe(201);
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
  return ((await response.json()) as { document: { id: string } }).document.id;
}
