import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  uniqueEmail,
  uploadText,
} from './helpers';

test('upload a new version, download the old one, and restore it', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('versions'));
  const workspaceId = await firstWorkspaceId(page.request);
  await uploadText(page.request, workspaceId, 'plan.txt');
  await openDocuments(page, workspaceId);

  const row = page.getByRole('listitem').filter({ hasText: 'plan.txt' });
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Versions' }).click();
  const modal = page.getByRole('dialog', { name: 'Versions of “plan.txt”' });
  await modal.getByLabel('New version file').setInputFiles({
    name: 'plan.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('the revised plan\n'),
  });
  await expect(page.getByText('plan.txt is now version 2')).toBeVisible();
  const versions = modal.getByRole('list', { name: 'Versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await expect(versions.getByRole('listitem').first()).toContainText('Current version');

  // The earlier version still downloads as it was.
  const downloadPromise = page.waitForEvent('download');
  await modal.getByRole('link', { name: 'Download version 1' }).click();
  const original = await downloadPromise;
  expect(readFileSync((await original.path())!).toString()).toBe('hello from plan.txt\n');

  await modal.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog', { name: 'Restore version 1?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Version 1 restored as version 3')).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(3);
  await modal.getByRole('button', { name: 'Close dialog' }).click();

  await expect(row.getByText('v3', { exact: true })).toBeVisible();
  const current = page.waitForEvent('download');
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  expect(readFileSync((await (await current).path())!).toString()).toBe('hello from plan.txt\n');
});
