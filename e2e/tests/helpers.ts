import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

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

/** Registers through the API (sets the session cookie on this request context). */
export async function registerViaApi(request: APIRequestContext, email: string): Promise<void> {
  const response = await request.post('/api/auth/register', { data: { email, password: PASSWORD } });
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
