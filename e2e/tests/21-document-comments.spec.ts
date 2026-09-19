import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  uniqueEmail,
  uploadText,
} from './helpers';

test('comment on a document, edit it, and delete it', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('comments'));
  const workspaceId = await firstWorkspaceId(page.request);
  await uploadText(page.request, workspaceId, 'brief.txt');
  await openDocuments(page, workspaceId);

  const row = page.getByRole('listitem').filter({ hasText: 'brief.txt' });
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Comments' }).click();
  const modal = page.getByRole('dialog', { name: 'Comments on “brief.txt”' });
  await expect(modal.getByText('No comments yet')).toBeVisible();

  await modal.getByLabel('New comment').fill('Can we tighten\nthe second paragraph?');
  await modal.getByRole('button', { name: 'Comment', exact: true }).click();
  const thread = modal.getByRole('list', { name: 'Comments' });
  await expect(thread.getByRole('listitem')).toHaveCount(1);
  await expect(thread).toContainText('the second paragraph?');
  await expect(modal.getByLabel('New comment')).toHaveValue('');

  // A second one with the keyboard shortcut.
  await modal.getByLabel('New comment').fill('Also the title.');
  await modal.getByLabel('New comment').press('ControlOrMeta+Enter');
  await expect(thread.getByRole('listitem')).toHaveCount(2);

  await thread.getByRole('listitem').first().getByRole('button', { name: 'Edit comment' }).click();
  await modal.getByRole('textbox', { name: 'Edit comment' }).fill('Can we tighten the intro?');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(thread.getByRole('listitem').first()).toContainText('Can we tighten the intro?');
  await expect(thread.getByRole('listitem').first()).toContainText('edited');

  await thread.getByRole('listitem').last().getByRole('button', { name: 'Delete comment' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this comment?' })
    .getByRole('button', { name: 'Delete comment' })
    .click();
  await expect(thread.getByRole('listitem')).toHaveCount(1);

  // The thread is stored, not just shown: it is still there after reopening.
  await modal.getByRole('button', { name: 'Close dialog' }).click();
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Comments' }).click();
  await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(1);
});
