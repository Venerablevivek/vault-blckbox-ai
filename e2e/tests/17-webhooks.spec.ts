import { expect, test } from '@playwright/test';
import { firstWorkspaceId, forbidNativeDialogs, registerViaApi, uniqueEmail } from './helpers';

test('an owner adds a webhook, and the server refuses to send anywhere private', async ({ page }) => {
  forbidNativeDialogs(page);
  await registerViaApi(page.request, uniqueEmail('hooks'));
  const workspaceId = await firstWorkspaceId(page.request);
  await page.goto(`/workspaces/${workspaceId}/settings`);
  const panel = page.getByRole('region', { name: 'Webhooks' });

  // Plain http is refused outright.
  await panel.getByLabel('Endpoint URL').fill('http://hooks.example.com/vault');
  await panel.getByRole('button', { name: 'Add webhook' }).click();
  await expect(panel.getByText('Webhook URLs must use https.')).toBeVisible();

  // A name that resolves to this machine passes the URL check, but not the connection.
  await panel.getByLabel('Endpoint URL').fill('https://localhost./vault');
  await panel.getByLabel('Link created').check();
  await panel.getByRole('button', { name: 'Add webhook' }).click();
  await expect(panel.getByTestId('webhook-secret')).toHaveText(/^whsec_[A-Za-z0-9_-]{32}$/);
  await panel.getByRole('button', { name: 'Done' }).click();

  const hook = panel.getByRole('list', { name: 'Webhooks' }).getByRole('listitem').first();
  await expect(hook).toContainText('https://localhost./vault');
  await expect(hook).toContainText('2 events');
  await hook.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(/Test failed: .*private or reserved/)).toBeVisible();
  await hook.getByRole('button', { name: 'Deliveries' }).click();
  await expect(hook.getByRole('list', { name: 'Recent deliveries' })).toContainText('webhook.ping');

  await hook.getByRole('button', { name: 'Switch off' }).click();
  await expect(page.getByText('Webhook switched off')).toBeVisible();
  await expect(hook).toContainText('Off');
});
