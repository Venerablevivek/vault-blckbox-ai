import { expect, test } from '@playwright/test';
import { firstWorkspaceId, forbidNativeDialogs, openDocuments, registerViaApi, uniqueEmail } from './helpers';

test('someone without an account sends files through a file request', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('requests'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);

  await page.getByRole('button', { name: 'Request files' }).click();
  const panel = page.getByRole('dialog', { name: 'File requests' });
  await panel.getByPlaceholder('e.g. Signed contract and ID').fill('Signed contract');
  await panel.getByPlaceholder('What should they send?').fill('The signed PDF, please.');
  await panel.getByPlaceholder('No limit').fill('2');
  await panel.getByRole('button', { name: 'Create request' }).click();
  const link = await panel.getByLabel('Request link').inputValue();
  expect(link).toMatch(/\/r\/frq_/);

  // The person sending has no account: a fresh browser with no cookies.
  const guest = await browser.newContext();
  const outsider = await guest.newPage();
  await outsider.goto(new URL(link).pathname);
  await expect(outsider.getByRole('heading', { name: 'Signed contract' })).toBeVisible();
  await expect(outsider.getByText('The signed PDF, please.')).toBeVisible();
  await expect(outsider.getByText('2 files left')).toBeVisible();

  await outsider.getByLabel('Your name').fill('Dana Client');
  await outsider.getByLabel('Email (optional)').fill('dana@client.test');
  await outsider.getByLabel('Choose files to send').setInputFiles([
    { name: 'contract.txt', mimeType: 'text/plain', buffer: Buffer.from('signed\n') },
    { name: 'annex.txt', mimeType: 'text/plain', buffer: Buffer.from('annex\n') },
  ]);
  await outsider.getByRole('button', { name: 'Send 2 files' }).click();
  await expect(outsider.getByText('All 2 files were sent.')).toBeVisible();
  // The limit is reached: nothing more can be chosen, and the link now reads as closed.
  await expect(outsider.getByRole('button', { name: 'Choose files' })).toBeDisabled();
  const reopened = await outsider.goto(new URL(link).pathname);
  expect(reopened?.status()).toBe(410);
  await expect(outsider.getByRole('heading', { name: 'This file request is closed' })).toBeVisible();
  await guest.close();

  // Back in the workspace: the files are there, and the request says who sent them.
  await panel.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'contract.txt' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'annex.txt' })).toBeVisible();
  await page.getByRole('button', { name: 'Request files' }).click();
  const requests = page.getByRole('list', { name: 'File requests' });
  await expect(requests).toContainText('2 of 2 received');
  await expect(requests).toContainText('Complete');
  await requests.getByRole('button', { name: 'Files received for Signed contract' }).click();
  await expect(page.getByRole('list', { name: 'Received files' })).toContainText('Dana Client <dana@client.test>');
});
