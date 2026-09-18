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

/** Every zip starts with a local file header: "PK" 03 04. */
const ZIP_SIGNATURE = '504b0304';

test('select documents to download them as one zip, move them to the trash and restore them', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('bulk'));
  const workspaceId = await firstWorkspaceId(page.request);
  for (const name of ['one.txt', 'two.txt', 'three.txt']) await uploadText(page.request, workspaceId, name);
  await openDocuments(page, workspaceId);

  await page.getByRole('checkbox', { name: 'Select one.txt' }).check();
  await page.getByRole('checkbox', { name: 'Select two.txt' }).check();
  const toolbar = page.getByRole('toolbar', { name: 'Selected documents' });
  await expect(toolbar).toContainText('2 documents selected');

  // The zip is streamed from the API through the web origin, with the files' own names inside.
  const downloadPromise = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: 'Download zip' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^documents-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = readFileSync((await download.path())!);
  expect(zip.subarray(0, 4).toString('hex')).toBe(ZIP_SIGNATURE);
  const text = zip.toString('latin1');
  expect(text).toContain('one.txt');
  expect(text).toContain('hello from two.txt');
  expect(text).not.toContain('three.txt');

  await toolbar.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByText('2 documents moved to the trash')).toBeVisible();
  await expect(toolbar).toBeHidden();
  await expect(page.getByRole('button', { name: 'three.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'one.txt', exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: /Trash/ }).click();
  await page.getByRole('checkbox', { name: 'Select all documents shown' }).check();
  await expect(toolbar).toContainText('2 documents selected');
  await toolbar.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('2 documents restored')).toBeVisible();
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('button', { name: 'one.txt', exact: true })).toBeVisible();
});

test('a folder downloads as a zip named after it', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('folderzip'));
  const workspaceId = await firstWorkspaceId(page.request);
  const folder = await page.request.post(`/api/workspaces/${workspaceId}/folders`, { data: { name: 'Board pack' } });
  const folderId = (await folder.json()).folder.id as string;
  const doc = await uploadText(page.request, workspaceId, 'minutes.txt');
  await page.request.patch(`/api/documents/${doc}`, { data: { folderId } });
  await openDocuments(page, workspaceId);

  const row = page.getByRole('listitem').filter({ hasText: 'Board pack' });
  await row.getByRole('button', { name: 'More actions' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download as zip' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Board pack.zip');
  const zip = readFileSync((await download.path())!);
  expect(zip.subarray(0, 4).toString('hex')).toBe(ZIP_SIGNATURE);
  expect(zip.toString('latin1')).toContain('hello from minutes.txt');
});
