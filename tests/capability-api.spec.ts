import {test, expect, pluginFrame} from './fixtures';

/**
 * The imperative / data-only channel over @quilted/threads: the plugin calls host
 * methods and the host renders its own native UI. Command `run` callbacks are
 * proxied back into the plugin when the user selects them.
 */
test.describe('capability API', () => {
  test('a toast triggered from inside the iframe is rendered by the host', async ({
    connectedPage: page,
  }) => {
    await pluginFrame(page)
      .getByRole('button', {name: 'Show a toast'})
      .click();

    const toast = page.locator('.toast-region .toast');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Hello from the Notes plugin');
  });

  test('the plugin registers its command-palette entries', async ({
    connectedPage: page,
  }) => {
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette')).toBeVisible();
    await expect(page.locator('.palette-item-title')).toHaveText([
      'Notes: Say hello',
      'Notes: Open details',
    ]);
  });

  test('selecting a command runs its plugin callback (host toast)', async ({
    connectedPage: page,
  }) => {
    await page.locator('.cmdk-button').click();
    await page
      .locator('.palette-item', {hasText: 'Notes: Say hello'})
      .click();

    await expect(page.locator('.toast-region .toast')).toHaveText(
      '👋 Hello from the example plugin!',
    );
  });

  test('selecting a command runs its plugin callback (open modal)', async ({
    connectedPage: page,
  }) => {
    await page.locator('.cmdk-button').click();
    await page
      .locator('.palette-item', {hasText: 'Notes: Open details'})
      .click();

    await expect(page.locator('.palette')).toHaveCount(0);
    await expect(
      page.locator('.modal-layer .modal .modal-header h2'),
    ).toHaveText('Plugin details (rendered by the host)');
  });

  test('the command palette filters by query', async ({connectedPage: page}) => {
    await page.locator('.cmdk-button').click();
    await page.locator('.palette-input').fill('hello');
    await expect(page.locator('.palette-item-title')).toHaveText([
      'Notes: Say hello',
    ]);
  });

  test('Cmd-K opens the palette when the host (not the iframe) has focus', async ({
    connectedPage: page,
  }) => {
    await page.locator('.brand').click();
    await page.keyboard.press('Meta+k');
    await expect(page.locator('.palette')).toBeVisible();
  });
});
