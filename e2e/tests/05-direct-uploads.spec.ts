import { expect, test } from '@playwright/test';
import { firstWorkspaceId, forbidNativeDialogs, openDocuments, registerViaApi, uniqueEmail } from './helpers';

const MiB = 1024 * 1024;

/** A PDF-looking file of `size` bytes: the first bytes are what the server type-checks. */
function pdfFile(name: string, size: number) {
  const buffer = Buffer.alloc(size, 0x20);
  Buffer.from('%PDF-1.4\n').copy(buffer, 0);
  return { name, mimeType: 'application/pdf', buffer };
}

test('a large file uploads straight to storage in parts, and resumes after an interruption', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('uploader'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);

  // 20 MiB = three 8 MiB parts. File bytes must go to storage, never through the web or API origin.
  const file = pdfFile('board-pack.pdf', 20 * MiB);
  const partPuts: string[] = [];
  const bytesThroughApp: number[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'PUT' && url.searchParams.has('partNumber'))
      partPuts.push(url.searchParams.get('partNumber')!);
    if (url.origin === new URL(page.url()).origin) bytesThroughApp.push(request.postDataBuffer()?.length ?? 0);
  });

  // First attempt: storage refuses part 3 every time, so the upload stops with parts 1 and 2 stored.
  await page.route(/partNumber=3/, (route) => route.abort('failed'));
  await page.locator('input[type="file"]').setInputFiles(file);
  const issue = page.getByRole('alert').filter({ hasText: 'board-pack.pdf didn’t upload' });
  await expect(issue).toBeVisible({ timeout: 30_000 });
  await page.unroute(/partNumber=3/);
  expect(new Set(partPuts)).toEqual(new Set(['1', '2', '3']));

  // Resuming sends only the part storage doesn't have.
  partPuts.length = 0;
  await issue.getByRole('button', { name: 'Resume upload' }).click();
  await expect(page.getByText('board-pack.pdf uploaded')).toBeVisible({ timeout: 30_000 });
  expect(partPuts).toEqual(['3']);
  await expect(page.getByRole('button', { name: 'board-pack.pdf', exact: true })).toBeVisible();

  expect(Math.max(0, ...bytesThroughApp)).toBeLessThan(MiB);

  const listing = await (await page.request.get(`/api/workspaces/${workspaceId}/documents`)).json();
  expect(listing.documents[0]).toMatchObject({ filename: 'board-pack.pdf', size: 20 * MiB });
  expect(listing.storage.usedBytes).toBe(20 * MiB);
});

test('cancelling an upload releases its reserved storage', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('canceller'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);

  // Slow the parts down enough to press Cancel mid-upload.
  await page.route(/partNumber=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(pdfFile('big.pdf', 12 * MiB));
  await page.getByRole('status').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('big.pdf: upload cancelled')).toBeVisible();

  await expect(async () => {
    const storage = await (await page.request.get(`/api/workspaces/${workspaceId}/storage`)).json();
    expect(storage.storage.usedBytes).toBe(0);
  }).toPass({ timeout: 10_000 });
  const listing = await (await page.request.get(`/api/workspaces/${workspaceId}/documents`)).json();
  expect(listing.documents).toHaveLength(0);
});

test('cancelling while the upload is still starting also releases its storage', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('early-cancel'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);

  // Hold the "start upload" response, so Cancel is pressed before the page knows the upload's id.
  await page.route(/\/api\/workspaces\/[^/]+\/uploads$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(pdfFile('early.pdf', 9 * MiB));
  await page.getByRole('status').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('early.pdf: upload cancelled')).toBeVisible({ timeout: 10_000 });

  await expect(async () => {
    const storage = await (await page.request.get(`/api/workspaces/${workspaceId}/storage`)).json();
    expect(storage.storage.usedBytes).toBe(0);
  }).toPass({ timeout: 10_000 });
});

test('a file whose content is not what its name says is refused', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('mislabel'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)]),
  });
  const issue = page.getByRole('alert').filter({ hasText: 'invoice.pdf didn’t upload' });
  await expect(issue).toContainText('File content could not be recognised', { timeout: 20_000 });
  await expect(issue.getByRole('button', { name: 'Resume upload' })).toHaveCount(0);
  const storage = await (await page.request.get(`/api/workspaces/${workspaceId}/storage`)).json();
  expect(storage.storage.usedBytes).toBe(0);
});
