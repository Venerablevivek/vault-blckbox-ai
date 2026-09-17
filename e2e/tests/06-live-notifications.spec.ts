import { expect, test } from '@playwright/test';
import { firstWorkspaceId, openDocuments, registerViaApi, uniqueEmail, uploadText } from './helpers';

test('the bell updates within seconds when a teammate uploads, without polling or reloading', async ({
  page,
  browser,
}) => {
  // Alice owns a workspace and invites Bob.
  const alice = await browser.newContext();
  await registerViaApi(alice.request, uniqueEmail('live-alice'));
  const workspaceId = await firstWorkspaceId(alice.request);
  const bobEmail = uniqueEmail('live-bob');
  const invite = await alice.request.post(`/api/workspaces/${workspaceId}/invitations`, { data: { email: bobEmail } });
  const inviteToken = ((await invite.json()) as { inviteUrl: string }).inviteUrl.split('/invite/')[1]!;

  // Bob joins by registering with the invitation, in the page's own context.
  await registerViaApi(page.request, bobEmail, inviteToken);

  const streams: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/notifications/stream')) streams.push(request.url());
  });
  await openDocuments(page, workspaceId);
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications');

  // Polling is every 20 seconds; the stream must deliver well before that.
  await uploadText(alice.request, workspaceId, 'quarterly-plan.txt');
  await expect(bell).toHaveAccessibleName('Notifications (1 unread)', { timeout: 8_000 });

  await bell.click();
  await expect(page.getByText('quarterly-plan.txt was added')).toBeVisible();
  await alice.close();
});
