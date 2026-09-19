import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { firstWorkspaceId, openDocuments, registerViaApi, simplePdf, uniqueEmail, uploadText } from './helpers';

/**
 * Automated WCAG 2.1 A/AA checks (axe-core) on every main screen, in the light and dark themes.
 * Automated checks find roughly a third of accessibility problems; keyboard use and screen-reader
 * labels are covered by the other specs, which drive the app by role and name.
 */
async function audit(page: Page, name: string) {
  // Dialogs fade in: measured mid-animation, their text is partly transparent and fails contrast.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
  );
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const report = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 5)
        .join('\n  ')}`,
  );
  expect(report, `${name}\n${report.join('\n')}`).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('signed-out pages', async ({ page }) => {
      for (const path of ['/login', '/register', '/forgot-password']) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        await audit(page, path);
      }
    });

    test('the workspace screens, dialogs and the command menu', async ({ page }) => {
      await registerViaApi(page.request, uniqueEmail(`a11y-${colorScheme}`));
      const workspaceId = await firstWorkspaceId(page.request);
      await page.request.post(`/api/workspaces/${workspaceId}/folders`, { data: { name: 'Contracts' } });
      const doc = await uploadText(page.request, workspaceId, 'notes.txt');
      await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
        multipart: { file: { name: 'board.pdf', mimeType: 'application/pdf', buffer: simplePdf('Board pack') } },
      });
      const share = (await (await page.request.post('/api/shares', { data: { documentId: doc } })).json()) as {
        share: { url: string };
      };

      await openDocuments(page, workspaceId);
      await audit(page, 'documents');
      await page.getByRole('checkbox', { name: 'Select notes.txt' }).check();
      await audit(page, 'documents with a selection');
      await page.getByRole('button', { name: 'Grid view' }).click();
      await audit(page, 'documents, grid');

      await page.getByRole('button', { name: 'Share', exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page, 'share panel');
      await page.keyboard.press('Escape');

      await page.request.post(`/api/documents/${doc}/comments`, { data: { body: 'Looks good to me.' } });
      await page.getByRole('button', { name: 'List view' }).click();
      await page
        .getByRole('listitem')
        .filter({ hasText: 'notes.txt' })
        .getByRole('button', { name: 'More actions' })
        .click();
      await page.getByRole('menuitem', { name: 'Comments' }).click();
      await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(1);
      await audit(page, 'comments');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Open the command menu' }).click();
      await page.getByRole('combobox', { name: 'Command' }).fill('se');
      await audit(page, 'command menu');
      await page.keyboard.press('Escape');

      for (const path of ['', '/members', '/activity', '/settings', '/account']) {
        await page.goto(`/workspaces/${workspaceId}${path}`);
        await page.waitForLoadState('networkidle');
        await audit(page, path || 'overview');
      }

      await page.goto(new URL(share.share.url).pathname);
      await audit(page, 'public share page');
    });
  });
}
