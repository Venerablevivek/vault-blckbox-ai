import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  uniqueEmail,
  uploadText,
} from './helpers';

test('starring a document puts it on the Starred tab, and opening one puts it first in Recent', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('starrer'));
  const workspaceId = await firstWorkspaceId(page.request);
  const alphaId = await uploadText(page.request, workspaceId, 'alpha.txt');
  await uploadText(page.request, workspaceId, 'beta.txt');
  await openDocuments(page, workspaceId);

  const tabs = page.getByRole('tablist', { name: 'Filter documents' });
  await page.getByRole('button', { name: 'Star alpha.txt' }).click();
  await expect(page.getByRole('button', { name: 'Unstar alpha.txt' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tabs.getByRole('tab', { name: /Starred/ })).toContainText('1');

  await tabs.getByRole('tab', { name: /Starred/ }).click();
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'beta.txt', exact: true })).toHaveCount(0);

  // Unstarring from the Starred tab takes it off the list.
  await page.getByRole('button', { name: 'Unstar alpha.txt' }).click();
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toHaveCount(0);
  await expect(tabs.getByRole('tab', { name: /Starred/ })).toContainText('0');

  // Downloading alpha (after beta was uploaded) makes it the most recent.
  expect((await page.request.get(`/api/documents/${alphaId}/download`)).ok()).toBe(true);
  await tabs.getByRole('tab', { name: /Recent/ }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '.txt' }).first()).toContainText('alpha.txt');
  await expect(page.getByLabel('Sort documents')).toHaveCount(0);
});
