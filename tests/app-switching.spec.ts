import {test, expect} from './fixtures';

const toolbarSection = '.nav .toolbar-section';

/**
 * The chrome can host multiple apps and switch between them. Switching away from
 * an integrated plugin unmounts it, which tears down its thread and removes its
 * contributed commands/toolbar; switching back re-establishes them.
 */
test.describe('app switching', () => {
  test('the app rail lists every registered app', async ({
    connectedPage: page,
  }) => {
    await expect(page.locator('.app-rail-item .app-rail-name')).toHaveText([
      'Example Notes',
      'Google',
    ]);
  });

  test('switching to the external app removes the plugin contributions', async ({
    connectedPage: page,
  }) => {
    // The plugin is active by default (the fixture waited for its toolbar).
    await expect(page.locator(toolbarSection)).toBeVisible();

    await page.locator('.app-rail-item', {hasText: 'Google'}).click();

    // External app iframe is shown; plugin's contributed toolbar is gone.
    await expect(page.locator('iframe[title="google"]')).toBeVisible();
    await expect(page.locator('iframe[title="example-notes"]')).toHaveCount(0);
    await expect(page.locator(toolbarSection)).toHaveCount(0);

    // And the plugin's command-palette entries are gone too.
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette-item')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('switching back to the plugin restores its contributions', async ({
    connectedPage: page,
  }) => {
    await page.locator('.app-rail-item', {hasText: 'Google'}).click();
    await expect(page.locator(toolbarSection)).toHaveCount(0);

    await page.locator('.app-rail-item', {hasText: 'Example Notes'}).click();

    // Plugin re-mounts, re-handshakes, and re-contributes.
    await expect(
      page.locator(`${toolbarSection} button`, {hasText: 'Open details'}),
    ).toBeVisible();
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette-item')).toHaveCount(2);
  });

  test('the external app marks itself as non-integrated in the titlebar', async ({
    connectedPage: page,
  }) => {
    await page.locator('.app-rail-item', {hasText: 'Google'}).click();
    await expect(page.locator('.app-badge.external')).toContainText(
      'no integration',
    );
  });
});
