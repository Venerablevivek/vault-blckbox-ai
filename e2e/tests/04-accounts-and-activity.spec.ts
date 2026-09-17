import { expect, test } from '@playwright/test';
import { firstWorkspaceId, forbidNativeDialogs, registerViaApi, uniqueEmail, uploadText } from './helpers';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MailpitMessage {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
}

/** Waits for Mailpit to receive a message for `to` with a subject containing `subject`. */
async function waitForEmail(request: import('@playwright/test').APIRequestContext, to: string, subject: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const list = (await (await request.get(`${MAILPIT}/api/v1/messages`)).json()) as { messages: MailpitMessage[] };
    const found = list.messages.find((m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject));
    if (found) {
      const message = (await (await request.get(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as { Text: string };
      return message.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}

test("an owner's dashboard and activity feed render every kind of event", async ({ page }) => {
  forbidNativeDialogs(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await registerViaApi(page.request, uniqueEmail('owner-activity'));
  const workspaceId = await firstWorkspaceId(page.request);
  const documentId = await uploadText(page.request, workspaceId, 'plan.txt');

  // One of each newer event type: folder, move, share edit, trash, restore, rename.
  const folder = await page.request.post(`/api/workspaces/${workspaceId}/folders`, { data: { name: 'Plans' } });
  const folderId = ((await folder.json()) as { folder: { id: string } }).folder.id;
  await page.request.patch(`/api/documents/${documentId}`, { data: { folderId } });
  const share = await page.request.post('/api/shares', { data: { documentId } });
  const shareId = ((await share.json()) as { share: { id: string } }).share.id;
  await page.request.patch(`/api/shares/${shareId}`, { data: { maxDownloads: 3 } });
  await page.request.delete(`/api/documents/${documentId}`);
  await page.request.post(`/api/documents/${documentId}/restore`);
  await page.request.patch(`/api/workspaces/${workspaceId}/folders/${folderId}`, { data: { name: 'Roadmaps' } });

  await page.goto(`/workspaces/${workspaceId}`);
  await expect(
    page.getByRole('heading', { name: 'Recent activity' }).or(page.getByText('Recent activity')),
  ).toBeVisible();
  await expect(page.getByText(/restored plan\.txt from the trash/)).toBeVisible();

  await page.goto(`/workspaces/${workspaceId}/activity`);
  for (const text of [
    /moved plan\.txt to the trash/,
    /created the folder Plans/,
    /renamed the folder Plans to Roadmaps/,
    /changed a share link's settings/,
  ]) {
    await expect(page.getByText(text).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('password reset by email, then the account page shows one session', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  const email = uniqueEmail('forgetful');
  // Registered in a separate context: that session must be ended by the reset.
  const other = await browser.newContext();
  await registerViaApi(other.request, email);

  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  // Wait for the new page: the login form also has an Email field.
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const text = await waitForEmail(page.request, email, 'Reset your Vault password');
  const link = /http\S+reset-password#token=pwr_[\w-]+/.exec(text)![0];
  await page.goto(new URL(link).pathname + new URL(link).hash);
  // The token is removed from the address bar once read.
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel('New password', { exact: true }).fill('a-new-passphrase-1');
  await page.getByLabel('Confirm new password').fill('a-new-passphrase-1');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/);

  expect((await other.request.get('/api/auth/me')).status()).toBe(401);
  await other.close();

  await page.getByRole('link', { name: /Account & security/ }).click();
  await expect(page.getByRole('heading', { name: 'Where you’re signed in' })).toBeVisible();
  await expect(page.getByText('This browser')).toBeVisible();
  const sessions = page.getByRole('region', { name: 'Where you’re signed in' });
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  await expect(sessions.getByRole('button', { name: 'Sign out everywhere else' })).toBeDisabled();

  await waitForEmail(page.request, email, 'Your Vault password was changed');

  // The used link can't be used again.
  await page.goto(new URL(link).pathname + new URL(link).hash);
  await page.getByLabel('New password', { exact: true }).fill('another-passphrase');
  await page.getByLabel('Confirm new password').fill('another-passphrase');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText('This link can’t be used')).toBeVisible();
});

test('an owner deletes a workspace after typing its name', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('deleter'));
  const created = await page.request.post('/api/workspaces', { data: { name: 'Scratch space' } });
  const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

  await page.goto(`/workspaces/${workspaceId}/settings`);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const dialog = page.getByRole('dialog', { name: /Delete “Scratch space”/ });
  await dialog.getByRole('textbox').fill('scratch space');
  await dialog.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(dialog.getByText('The name doesn’t match.')).toBeVisible();

  await dialog.getByRole('textbox').fill('Scratch space');
  await dialog.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page).not.toHaveURL(new RegExp(workspaceId));
  expect((await page.request.get(`/api/workspaces/${workspaceId}/storage`)).status()).toBe(404);
});
