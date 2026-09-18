import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  openDocuments,
  registerViaApi,
  uniqueEmail,
  waitForEmail,
} from './helpers';

/** A solid-colour PNG of the given size, so the page has a real picture to show. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9c)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a view-only link for named people: code by email, watermarked view, no download', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('sender'));
  const workspaceId = await firstWorkspaceId(page.request);
  const upload = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    multipart: { file: { name: 'floor-plan.png', mimeType: 'image/png', buffer: png(640, 400) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const recipient = uniqueEmail('recipient');

  // The sender restricts the link to one person and turns off downloading.
  await openDocuments(page, workspaceId);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const panel = page.getByRole('dialog', { name: /share/i });
  await panel.getByLabel('Only specific people').check();
  await panel.getByLabel('Email addresses allowed to open the link').fill(recipient);
  await panel.getByLabel('View only (no downloads)').check();
  await panel.getByRole('button', { name: 'Create link' }).click();
  const sharePath = new URL(await panel.locator('p.font-mono').innerText()).pathname;
  await expect(panel.getByText('View only', { exact: true })).toBeVisible();
  await expect(panel.getByText(recipient)).toBeVisible();

  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  await visitor.goto(sharePath);
  await expect(visitor.getByRole('heading', { name: 'This file was shared with specific people' })).toBeVisible();
  // Nothing about the file shows until the address is proved.
  await expect(visitor.getByText('floor-plan.png')).toHaveCount(0);

  // Someone else's address gets the same answer, and no code.
  await visitor.getByLabel('Your email address').fill(uniqueEmail('stranger'));
  await visitor.getByRole('button', { name: 'Email me a code' }).click();
  await expect(visitor.getByText(/If that address can open this link/)).toBeVisible();
  await visitor.getByRole('button', { name: 'Use a different address' }).click();

  await visitor.getByLabel('Your email address').fill(recipient.toUpperCase());
  await visitor.getByRole('button', { name: 'Email me a code' }).click();
  const code = /\b(\d{6})\b/.exec(await waitForEmail(page.request, recipient, 'is your code'))![1]!;
  await visitor.getByLabel(/6-digit code/).fill(code);
  await visitor.getByRole('button', { name: 'Open the file' }).click();

  await expect(visitor.getByRole('heading', { name: 'floor-plan.png' })).toBeVisible();
  await expect(visitor.getByText(`Opened as ${recipient}`)).toBeVisible();
  await expect(visitor.getByText('View only.')).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Download' })).toHaveCount(0);
  const image = visitor.getByRole('img', { name: 'floor-plan.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await expect(visitor.getByTestId('watermark')).toContainText(recipient);

  // The download endpoint refuses, even with the unlocked browser's cookie.
  const download = await visitor.request.get(`/api/shares/${sharePath.split('/s/')[1]}/download`, {
    maxRedirects: 0,
  });
  expect(download.status()).toBe(403);

  // The sender sees who opened it.
  await expect(async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: /share/i });
    await reopened.getByRole('button', { name: 'Activity' }).click();
    await expect(reopened.getByText(recipient).last()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await guest.close();
});
