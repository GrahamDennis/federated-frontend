import {test, expect} from '@playwright/test';

/**
 * The plugin loaded directly (no host). It must detect that it's standalone and
 * provide its own chrome so nearly all functionality still works — while
 * host-only capabilities are absent.
 */
const PLUGIN_URL = 'http://localhost:5174/';

test.describe('standalone mode', () => {
  test.beforeEach(async ({page}) => {
    await page.goto(PLUGIN_URL);
    await expect(page.locator('.sa-badge')).toHaveText('standalone');
  });

  test('detects standalone and renders its own chrome + toolbar', async ({
    page,
  }) => {
    await expect(page.locator('.app h1')).toContainText('Example Notes Plugin');
    await expect(page.locator('.app')).toContainText('Running standalone');
    // The contributed toolbar is rendered into the plugin's own header.
    await expect(page.locator('.sa-toolbar-section')).toContainText(
      'Notes plugin',
    );
  });

  test('toasts work, rendered by the plugin itself', async ({page}) => {
    await page.getByRole('button', {name: 'Show a toast'}).click();
    await expect(page.locator('.sa-toast')).toHaveText(
      'Hello from the Notes plugin',
    );
  });

  test('the whole-window modal works standalone', async ({page}) => {
    await page
      .locator('.sa-toolbar-section')
      .getByRole('button', {name: 'Open details'})
      .click();

    const modal = page.locator('.sa-modal-layer .sa-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.sa-modal-header h2')).toContainText(
      'rendered by the app',
    );

    await modal.getByRole('button', {name: 'Got it'}).click();
    await expect(page.locator('.sa-modal-layer .sa-modal')).toHaveCount(0);
  });

  test('the command palette works standalone', async ({page}) => {
    await page.locator('.sa-cmdk').click();
    await expect(page.locator('.sa-palette')).toBeVisible();
    await expect(page.locator('.sa-palette-item-title')).toHaveText([
      'Notes: Say hello',
      'Notes: Open details',
    ]);

    await page
      .locator('.sa-palette-item', {hasText: 'Notes: Open details'})
      .click();
    await expect(page.locator('.sa-modal-layer .sa-modal')).toBeVisible();
  });

  test('host-only app switching is unavailable', async ({page}) => {
    await expect(page.locator('.switcher .unavailable')).toContainText(
      'Only available when hosted',
    );
    await expect(page.locator('.switcher button')).toHaveCount(0);
  });
});
