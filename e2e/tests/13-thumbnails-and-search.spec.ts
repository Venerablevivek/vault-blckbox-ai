import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  simplePdf,
  uniqueEmail,
} from './helpers';

test('a PDF gets a thumbnail, and searching finds it by the words inside it', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('search'));
  const workspaceId = await firstWorkspaceId(page.request);
  const upload = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    multipart: {
      file: { name: 'board-pack.pdf', mimeType: 'application/pdf', buffer: simplePdf('Approved capital expenditure') },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);

  // The worker makes the thumbnail and reads the text shortly after the upload.
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/workspaces/${workspaceId}/documents`)).json()) as {
            documents: Array<{ thumbnail: boolean }>;
          }
        ).documents[0]?.thumbnail,
      { timeout: 30_000 },
    )
    .toBe(true);

  await openDocuments(page, workspaceId);
  await page.getByRole('button', { name: 'Grid view' }).click();
  const picture = page.getByRole('listitem').filter({ hasText: 'board-pack.pdf' }).locator('img');
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByPlaceholder('Search all documents').fill('expenditures');
  const snippet = page.getByTestId('match-snippet');
  await expect(snippet).toBeVisible();
  await expect(snippet.locator('mark')).toHaveText('expenditure');
  await expect(page.getByRole('button', { name: 'board-pack.pdf', exact: true })).toBeVisible();
});
