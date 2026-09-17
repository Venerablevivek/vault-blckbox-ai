import { expect, test } from '@playwright/test';
import { firstWorkspaceId, registerViaApi, uniqueEmail, uploadText } from './helpers';

test('a password-protected, download-limited link', async ({ page, browser }) => {
  await registerViaApi(page.request, uniqueEmail('protect'));
  const workspaceId = await firstWorkspaceId(page.request);
  const documentId = await uploadText(page.request, workspaceId, 'contract.txt');

  const created = await page.request.post('/api/shares', {
    data: { documentId, password: 'open-sesame', maxDownloads: 1 },
  });
  expect(created.status()).toBe(201);
  const sharePath = new URL(((await created.json()) as { share: { url: string } }).share.url).pathname;

  const outsider = await browser.newContext();
  const visitor = await outsider.newPage();

  await test.step('the file name is hidden until unlocked', async () => {
    await visitor.goto(sharePath);
    await expect(visitor.getByRole('heading', { name: 'This file is password protected' })).toBeVisible();
    await expect(visitor.getByText('contract.txt')).toHaveCount(0);
  });

  await test.step('a wrong password is rejected', async () => {
    await visitor.getByLabel('Password').fill('not-it');
    await visitor.getByRole('button', { name: 'Unlock' }).click();
    await expect(visitor.getByText('That password is not correct.')).toBeVisible();
  });

  await test.step('the right password unlocks it', async () => {
    await visitor.getByLabel('Password').fill('open-sesame');
    await visitor.getByRole('button', { name: 'Unlock' }).click();
    await expect(visitor.getByRole('heading', { name: 'contract.txt' })).toBeVisible();
  });

  await test.step('the single download is used, then the link is used up', async () => {
    const download = await visitor.request.get(`/api/shares/${sharePath.split('/').pop()}/download`, { maxRedirects: 0 });
    expect(download.status()).toBe(302);
    const again = await visitor.request.get(`/api/shares/${sharePath.split('/').pop()}/download`, { maxRedirects: 0 });
    expect(again.status()).toBe(410);

    const page410 = await visitor.goto(sharePath);
    expect(page410?.status()).toBe(410);
    await expect(visitor.getByRole('heading', { name: 'This link has already been used' })).toBeVisible();
  });

  await outsider.close();
});

test('an unknown share link is a real 404', async ({ page }) => {
  const response = await page.goto('/s/shr_this-token-does-not-exist-anywhere');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Link not found' })).toBeVisible();
});
