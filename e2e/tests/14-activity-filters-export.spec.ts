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

test("an owner filters the activity trail, opens one document's history, and exports it", async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('auditor'));
  const workspaceId = await firstWorkspaceId(page.request);
  const kept = await uploadText(page.request, workspaceId, 'kept.txt');
  const binned = await uploadText(page.request, workspaceId, 'binned.txt');
  await page.request.delete(`/api/documents/${binned}`);
  await page.request.post('/api/shares', { data: { documentId: kept } });

  await page.goto(`/workspaces/${workspaceId}/activity`);
  const trail = page.locator('ol');
  await expect(trail.getByText(/created a share link for kept\.txt/)).toBeVisible();

  await page.getByRole('tab', { name: 'Share links' }).click();
  await expect(trail.getByText(/created a share link for kept\.txt/)).toBeVisible();
  await expect(trail.getByText(/binned\.txt/)).toHaveCount(0);

  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(trail.getByText(/binned\.txt/).first()).toBeVisible();
  await expect(trail.getByText(/share link/)).toHaveCount(0);

  // One document's history, from its menu.
  await openDocuments(page, workspaceId);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'kept.txt' })
    .getByRole('button', { name: 'More actions' })
    .click();
  await page.getByRole('menuitem', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('Showing activity for')).toContainText('kept.txt');
  await expect(trail.getByText(/binned\.txt/)).toHaveCount(0);
  await expect(trail.getByText(/kept\.txt/).first()).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const csv = readFileSync((await (await downloadPromise).path())!).toString('utf8');
  const lines = (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).trim().split('\r\n');
  expect(lines[0]).toBe('time_utc,actor,action,resource_type,resource_id,file,details,hash');
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.slice(1).every((line) => line.includes(kept))).toBe(true);
  expect(csv).not.toContain('binned.txt');
});
