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

test('share a folder: the recipient browses it, downloads a file and a zip, and never leaves it', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('folder-sharer'));
  const workspaceId = await firstWorkspaceId(page.request);
  const folder = async (name: string, parentId: string | null = null) =>
    (await (await page.request.post(`/api/workspaces/${workspaceId}/folders`, { data: { name, parentId } })).json())
      .folder.id as string;
  const reports = await folder('Reports');
  const q1 = await folder('Q1', reports);
  const place = async (name: string, folderId: string) =>
    page.request.patch(`/api/documents/${await uploadText(page.request, workspaceId, name)}`, { data: { folderId } });
  await place('summary.txt', reports);
  await place('january.txt', q1);
  await uploadText(page.request, workspaceId, 'private.txt');

  await openDocuments(page, workspaceId);
  await page.getByRole('listitem').filter({ hasText: 'Reports' }).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Share folder…' }).click();
  const panel = page.getByRole('dialog', { name: /Share the folder/ });
  await panel.getByLabel('Require a password').check();
  await panel.getByLabel('Folder link password').fill('board-only');
  await panel.getByRole('button', { name: 'Create folder link' }).click();
  const linkPath = new URL(await panel.locator('p.font-mono').innerText()).pathname;
  expect(linkPath).toMatch(/^\/f\/fsh_[A-Za-z0-9_-]+$/);

  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  await visitor.goto(linkPath);
  await expect(visitor.getByRole('heading', { name: 'This folder is password protected' })).toBeVisible();
  await expect(visitor.getByText('summary.txt')).toHaveCount(0);
  await visitor.getByLabel('Password').fill('board-only');
  await visitor.getByRole('button', { name: 'Unlock' }).click();

  await expect(visitor.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(visitor.getByText('summary.txt')).toBeVisible();
  await expect(visitor.getByText('private.txt')).toHaveCount(0);

  const filePromise = visitor.waitForEvent('download');
  await visitor.getByRole('link', { name: 'Download summary.txt' }).click();
  const file = await filePromise;
  expect(file.suggestedFilename()).toBe('summary.txt');
  expect(readFileSync((await file.path())!).toString()).toBe('hello from summary.txt\n');

  await visitor.getByRole('link', { name: /^Q1/ }).click();
  await expect(visitor.getByRole('heading', { name: 'Q1' })).toBeVisible();
  await expect(visitor.getByText('january.txt')).toBeVisible();
  const zipPromise = visitor.waitForEvent('download');
  await visitor.getByRole('button', { name: 'Download this folder' }).click();
  const zip = await zipPromise;
  expect(zip.suggestedFilename()).toBe('Q1.zip');
  expect(readFileSync((await zip.path())!).toString('latin1')).toContain('hello from january.txt');

  await visitor.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'Reports' }).click();
  await expect(visitor.getByRole('heading', { name: 'Reports' })).toBeVisible();

  // A folder outside the shared one can't be reached by editing the address.
  const outside = await folder('Elsewhere');
  const escape = await visitor.goto(`${linkPath}?folder=${outside}`);
  expect(escape?.status()).toBe(200);
  await expect(visitor.getByText('Link not found')).toBeVisible();

  // The sender sees it being used, then revokes it: the page answers 410.
  await expect(async () => {
    await page.reload();
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Reports' })
      .getByRole('button', { name: 'More actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Share folder…' }).click();
    await expect(page.getByRole('dialog', { name: /Share the folder/ }).getByText('1 open')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  const reopened = page.getByRole('dialog', { name: /Share the folder/ });
  await expect(reopened.getByText('2 downloads')).toBeVisible();
  await reopened.getByRole('button', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke this folder link?' })
    .getByRole('button', { name: 'Revoke link' })
    .click();
  await expect(page.getByText('Link revoked')).toBeVisible();
  const dead = await visitor.goto(linkPath);
  expect(dead?.status()).toBe(410);
  await expect(visitor.getByText('This link is no longer available')).toBeVisible();
  await guest.close();
});
