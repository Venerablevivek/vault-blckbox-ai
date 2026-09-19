import { expect, test } from '@playwright/test';
import {
  firstWorkspaceId,
  forbidNativeDialogs,
  registerViaApi,
  uniqueEmail,
  uploadText,
  waitForEmail,
} from './helpers';

test('a person chooses to be emailed about uploads at once, and to stop seeing them in the app', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  const ownerEmail = uniqueEmail('settings-owner');
  await registerViaApi(page.request, ownerEmail);
  const workspaceId = await firstWorkspaceId(page.request);

  // A teammate, who will upload.
  const teammate = await browser.newContext();
  const teammateEmail = uniqueEmail('settings-teammate');
  const invite = await page.request.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: teammateEmail },
  });
  await registerViaApi(
    teammate.request,
    teammateEmail,
    ((await invite.json()) as { inviteUrl: string }).inviteUrl.split('/invite/')[1],
  );

  await page.goto(`/workspaces/${workspaceId}/account`);
  const settings = page.getByRole('region', { name: 'Notifications' });
  await settings.getByLabel('Email at once: A document is added or updated').check();
  await settings.getByLabel('Show in app: A document is added or updated').uncheck();
  // Essential ones can't be switched off.
  await expect(settings.getByLabel('Show in app: Malware is found in a file you uploaded')).toBeDisabled();
  await settings.getByLabel('Summary email of unread notifications').selectOption('weekly');
  await settings.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Notification settings saved')).toBeVisible();

  await page.reload();
  await expect(settings.getByLabel('Email at once: A document is added or updated')).toBeChecked();
  await expect(settings.getByLabel('Summary email of unread notifications')).toHaveValue('weekly');

  await uploadText(teammate.request, workspaceId, 'forecast.txt');
  const email = await waitForEmail(page.request, ownerEmail, 'forecast.txt was added');
  expect(email).toContain(`/workspaces/${workspaceId}`);
  const inbox = (await (await page.request.get('/api/notifications')).json()) as { notifications: unknown[] };
  expect(inbox.notifications).toHaveLength(0);
  await teammate.close();
});
