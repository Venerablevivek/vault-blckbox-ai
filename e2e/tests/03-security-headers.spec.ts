import { expect, test } from '@playwright/test';
import { firstWorkspaceId, registerViaApi, uniqueEmail } from './helpers';

test('web pages carry security headers', async ({ request }) => {
  for (const path of ['/login', '/s/shr_unknown-token-for-header-check']) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy'], path).toContain("object-src 'none'");
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['referrer-policy'], path).toBe('no-referrer');
    expect(headers['x-powered-by'], path).toBeUndefined();
  }
});

test('dialogs trap focus and return it on close', async ({ page }) => {
  await registerViaApi(page.request, uniqueEmail('focus'));
  await page.goto(`/workspaces/${await firstWorkspaceId(page.request)}/documents`);

  const opener = page.getByRole('button', { name: /new folder/i });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await expect(dialog).toBeVisible();

  // Tab many times: focus never leaves the dialog.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
