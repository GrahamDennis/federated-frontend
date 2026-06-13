import type {Page} from '@playwright/test';
import {test, expect, pluginFrame} from './fixtures';

const toolbarSection = '.nav .toolbar-section';
const notesRail = (page: Page) =>
  page.locator('.app-rail-item', {hasText: 'Example Notes'});
const googleRail = (page: Page) =>
  page.locator('.app-rail-item', {hasText: 'Google'});

/**
 * The chrome hosts multiple apps and switches between them. Apps are kept alive
 * (mounted) when backgrounded; only the active app's contributions are surfaced.
 */
test.describe('app switching', () => {
  test('the app rail lists every registered app', async ({
    connectedPage: page,
  }) => {
    await expect(page.locator('.app-rail-item .app-rail-name')).toHaveText([
      'Example Notes',
      'World Map',
      'Google',
    ]);
  });

  test('switching to the external app hides the plugin and its contributions', async ({
    connectedPage: page,
  }) => {
    await expect(page.locator(toolbarSection)).toBeVisible();

    await googleRail(page).click();

    // External app is shown.
    await expect(page.locator('iframe[title="google"]')).toBeVisible();
    // The plugin stays mounted (kept alive) but hidden — not removed.
    await expect(page.locator('iframe[title="example-notes"]')).toHaveCount(1);
    await expect(page.locator('iframe[title="example-notes"]')).toBeHidden();

    // Its contributions are no longer surfaced.
    await expect(page.locator(toolbarSection)).toHaveCount(0);
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette-item')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('a backgrounded plugin is marked as still running in the rail', async ({
    connectedPage: page,
  }) => {
    await googleRail(page).click();
    await expect(notesRail(page)).toContainText('running');
  });

  test('switching back to the plugin restores its contributions', async ({
    connectedPage: page,
  }) => {
    await googleRail(page).click();
    await expect(page.locator(toolbarSection)).toHaveCount(0);

    await notesRail(page).click();

    await expect(
      page.locator(`${toolbarSection} button`, {hasText: 'Open details'}),
    ).toBeVisible();
    await page.locator('.cmdk-button').click();
    await expect(page.locator('.palette-item')).toHaveCount(2);
    await page.keyboard.press('Escape');
  });

  test('a backgrounded plugin keeps its state alive across switches', async ({
    connectedPage: page,
  }) => {
    // Put the plugin into a non-default state from inside its iframe.
    await pluginFrame(page)
      .getByRole('button', {name: 'Open the modal'})
      .click();
    await expect(page.locator('.modal-layer .modal')).toBeVisible();

    // Background it: its modal contribution is no longer shown in the chrome...
    await googleRail(page).click();
    await expect(page.locator('.modal-layer .modal')).toHaveCount(0);

    // ...but coming back restores the modal, proving the plugin's JS context (its
    // store) survived rather than reloading from scratch.
    await notesRail(page).click();
    await expect(page.locator('.modal-layer .modal')).toBeVisible();
  });

  test('the external app marks itself as non-integrated in the titlebar', async ({
    connectedPage: page,
  }) => {
    await googleRail(page).click();
    await expect(page.locator('.app-badge.external')).toContainText(
      'no integration',
    );
  });

  test('a hosted plugin can switch the shell to a sibling app', async ({
    connectedPage: page,
  }) => {
    // The plugin learns about siblings via host.listApps() and offers to switch.
    await pluginFrame(page).getByRole('button', {name: 'Open Google'}).click();

    await expect(page.locator('iframe[title="google"]')).toBeVisible();
    await expect(page.locator(toolbarSection)).toHaveCount(0);
  });
});
