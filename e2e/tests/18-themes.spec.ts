import { expect, test } from '@playwright/test';
import { firstWorkspaceId, openDocuments, registerViaApi, uniqueEmail } from './helpers';

test('follows the system theme, and remembers an explicit choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await registerViaApi(page.request, uniqueEmail('theme'));
  const workspaceId = await firstWorkspaceId(page.request);
  await openDocuments(page, workspaceId);
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
  const theme = page.getByRole('radiogroup', { name: 'Theme' });

  expect(await isDark()).toBe(true);
  await expect(theme.getByRole('radio', { name: 'System theme' })).toHaveAttribute('aria-checked', 'true');

  await theme.getByRole('radio', { name: 'Light theme' }).click();
  expect(await isDark()).toBe(false);
  // Watch for the dark class appearing at any point during the next load: hydration must not
  // flash the system theme over an explicit choice, even for one frame.
  await page.addInitScript(() => {
    (window as unknown as { darkEverApplied: boolean }).darkEverApplied = false;
    new MutationObserver(() => {
      if (document.documentElement.classList.contains('dark')) {
        (window as unknown as { darkEverApplied: boolean }).darkEverApplied = true;
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  });
  await page.reload();
  // Applied before the first paint, and the switch shows the stored choice.
  expect(await isDark()).toBe(false);
  await expect(theme.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as unknown as { darkEverApplied: boolean }).darkEverApplied)).toBe(false);

  // Back to "system": it follows the operating system again, including when it changes.
  await theme.getByRole('radio', { name: 'System theme' }).click();
  expect(await isDark()).toBe(true);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(isDark).toBe(false);
});
