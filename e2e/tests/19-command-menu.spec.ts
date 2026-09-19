import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  simplePdf,
  uniqueEmail,
} from './helpers';

test('the command menu jumps to pages, finds documents by their contents, and switches theme', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('commands'));
  const workspaceId = await firstWorkspaceId(page.request);
  await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    multipart: {
      file: { name: 'q3-board.pdf', mimeType: 'application/pdf', buffer: simplePdf('Approved lighthouse budget') },
    },
  });
  // Wait until the worker has read the PDF's text.
  await expect
    .poll(
      async () => {
        const found = (await (
          await page.request.get(`/api/workspaces/${workspaceId}/documents?q=lighthouse`)
        ).json()) as {
          documents: unknown[];
        };
        return found.documents.length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  await openDocuments(page, workspaceId);
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  const input = menu.getByRole('combobox', { name: 'Command' });

  // Keyboard: open, filter, arrow, Enter.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toBeFocused();
  await input.fill('activity');
  await expect(menu.getByRole('option', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/activity$`));
  await expect(menu).toBeHidden();

  // A word from inside the PDF finds it; choosing it opens the documents page searching for it.
  await page.getByRole('button', { name: 'Open the command menu' }).click();
  await input.fill('lighthouse');
  const result = menu.getByRole('option', { name: /q3-board\.pdf/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/documents\?q=q3-board\.pdf$/);
  await expect(page.getByRole('button', { name: 'q3-board.pdf', exact: true })).toBeVisible();

  // Theme, and Escape closes.
  await page.keyboard.press('ControlOrMeta+k');
  await input.fill('dark theme');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await expect(page.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
