import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, PASSWORD, uniqueEmail, waitForEmail } from './helpers';

/**
 * The main journey, entirely through the browser: sign up, upload, organise, share, have an
 * outsider open the link, see accurate activity, revoke, trash and restore.
 */
test('owner uploads, shares, tracks, revokes, trashes and restores a document', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  const email = uniqueEmail('owner');

  await test.step('sign up lands on the workspace dashboard', async () => {
    await page.goto('/register');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}$/);
  });

  const workspaceUrl = page.url();

  await test.step('confirms the email address from the link in the email', async () => {
    await expect(page.getByText('Confirm your email address to share documents')).toBeVisible();
    const text = await waitForEmail(page.request, email, 'Confirm your email address');
    const link = new URL(/http\S+verify-email#token=evt_[\w-]+/.exec(text)![0]);
    await page.goto(link.pathname + link.hash);
    await expect(page.getByRole('heading', { name: 'Email address confirmed' })).toBeVisible();
    await page.goto(workspaceUrl);
    await expect(page.getByRole('heading', { name: /My Workspace|Overview/ }).first()).toBeVisible();
    await expect(page.getByText('Confirm your email address to share documents')).toHaveCount(0);
  });

  await test.step('upload a file from the documents page', async () => {
    await page.goto(`${workspaceUrl}/documents`);
    await expect(page.getByText('No documents yet')).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'quarterly-report.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Quarterly numbers\n'),
    });
    await expect(page.getByRole('button', { name: 'quarterly-report.txt', exact: true })).toBeVisible();
  });

  await test.step('rename uses the in-app dialog, not a browser prompt', async () => {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename document' });
    await expect(dialog).toBeVisible();
    // Focus starts inside the dialog.
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await dialog.getByLabel('Name').fill('q3-report.txt');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'q3-report.txt', exact: true })).toBeVisible();
  });

  await test.step('create a folder', async () => {
    await page.getByRole('button', { name: /new folder/i }).click();
    const dialog = page.getByRole('dialog', { name: 'New folder' });
    await dialog.getByRole('textbox').fill('Finance');
    await dialog.getByRole('button', { name: /create|save/i }).click();
    await expect(page.getByText('Finance', { exact: true }).first()).toBeVisible();
  });

  let sharePath = '';
  await test.step('create a share link', async () => {
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const panel = page.getByRole('dialog', { name: /share/i });
    await panel.getByRole('button', { name: 'Create link' }).click();
    const url = await panel.locator('p.font-mono').innerText();
    sharePath = new URL(url).pathname;
    expect(sharePath).toMatch(/^\/s\/shr_[A-Za-z0-9_-]+$/);
    await panel.getByRole('button', { name: 'Close dialog' }).click();
  });

  await test.step('an outsider opens the link twice, and a link-preview bot fetches it', async () => {
    // A client-supplied X-Forwarded-For must not create extra "viewers".
    const outsider = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.77' } });
    const visitor = await outsider.newPage();
    const first = await visitor.goto(sharePath);
    expect(first?.status()).toBe(200);
    await expect(visitor.getByRole('heading', { name: 'q3-report.txt' })).toBeVisible();
    await visitor.waitForLoadState('networkidle');
    await visitor.reload();
    await visitor.waitForLoadState('networkidle');
    await outsider.close();

    const bot = await browser.newContext({ userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' });
    await (await bot.newPage()).goto(sharePath);
    await bot.close();
  });

  await test.step('the owner sees exactly one open from one viewer', async () => {
    // Views are recorded asynchronously; reopen the panel until they appear.
    await expect(async () => {
      await page.reload();
      await page.getByRole('button', { name: 'Share', exact: true }).first().click();
      const panel = page.getByRole('dialog', { name: /share/i });
      await expect(panel.getByText('opens', { exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const panel = page.getByRole('dialog', { name: /share/i });
    const opens = panel.getByText('opens', { exact: true }).locator('xpath=preceding-sibling::p[1]');
    await expect(opens).toHaveText('1');
    const viewers = panel.getByText('viewers', { exact: true }).locator('xpath=preceding-sibling::p[1]');
    await expect(viewers).toHaveText('~1');
  });

  await test.step('revoking asks in-app, and the link then returns 410', async () => {
    const panel = page.getByRole('dialog', { name: /share/i });
    await panel.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke this link?' });
    await confirm.getByRole('button', { name: 'Revoke link' }).click();
    await expect(confirm).toBeHidden();
    await expect(panel.getByText('No links yet. Create one below.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    const response = await page.request.get(sharePath);
    expect(response.status()).toBe(410);
  });

  await test.step('trash and restore', async () => {
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'q3-report.txt', exact: true }) });
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
    await expect(page.getByRole('button', { name: 'q3-report.txt', exact: true })).toBeHidden();

    await page.getByRole('tab', { name: /trash/i }).click();
    const trashed = page.getByRole('button', { name: 'q3-report.txt', exact: true });
    await expect(trashed).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(trashed).toBeHidden();

    await page.getByRole('tab', { name: /^all/i }).click();
    await expect(page.getByRole('button', { name: 'q3-report.txt', exact: true })).toBeVisible();
  });
});
