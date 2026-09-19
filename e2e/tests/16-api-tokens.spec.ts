import { expect, request as playwrightRequest, test } from '@playwright/test';
import { firstWorkspaceId, forbidNativeDialogs, registerViaApi, uniqueEmail } from './helpers';

test('a person makes a read-only API token, uses it from a script, and revokes it', async ({ page, baseURL }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('tokens'));
  const workspaceId = await firstWorkspaceId(page.request);

  await page.goto(`/workspaces/${workspaceId}/account`);
  const section = page.getByRole('region', { name: 'API tokens' });
  await section.getByLabel('New token name').fill('reporting script');
  await section.getByLabel('Access').selectOption('read');
  await section.getByRole('button', { name: 'Create token' }).click();
  const secret = (await section.getByTestId('token-secret').innerText()).trim();
  expect(secret).toMatch(/^vlt_[A-Za-z0-9_-]{43}$/);

  // A script: no cookies, only the token, through the same /api the web app uses.
  const script = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  const workspaces = await script.get('/api/workspaces');
  expect(workspaces.status()).toBe(200);
  expect(((await workspaces.json()) as { workspaces: Array<{ id: string }> }).workspaces[0]!.id).toBe(workspaceId);
  const write = await script.post(`/api/workspaces/${workspaceId}/folders`, { data: { name: 'Nope' } });
  expect(write.status()).toBe(403);

  await section.getByRole('button', { name: 'Done' }).click();
  await expect(section.getByRole('list', { name: 'Your API tokens' })).toContainText('reporting script');
  await section.getByRole('button', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: /Revoke/ })
    .getByRole('button', { name: 'Revoke token' })
    .click();
  await expect(page.getByText('Token revoked')).toBeVisible();
  expect((await script.get('/api/workspaces')).status()).toBe(401);
  await script.dispose();
});
