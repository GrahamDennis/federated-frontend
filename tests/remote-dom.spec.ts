import {test, expect, pluginFrame} from './fixtures';

/**
 * The declarative / component-contribution channel: the plugin authors a
 * remote-dom tree that the host renders with its own components and portals into
 * the chrome — escaping the iframe.
 */
test.describe('remote-dom contributions', () => {
  test('plugin contributes a toolbar section into the host nav', async ({
    connectedPage: page,
  }) => {
    const section = page.locator('.nav .toolbar-section');
    await expect(section).toContainText('Notes plugin');
    await expect(
      section.getByRole('button', {name: 'Open details'}),
    ).toBeVisible();
    await expect(
      section.getByRole('button', {name: 'Quick save'}),
    ).toBeVisible();
  });

  test('a contributed button press opens a whole-window host-rendered modal', async ({
    connectedPage: page,
  }) => {
    await page
      .locator('.nav .toolbar-section button', {hasText: 'Open details'})
      .click();

    const modal = page.locator('.modal-layer .modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-header h2')).toHaveText(
      'Plugin details (rendered by the host)',
    );
  });

  test('the modal is rendered by the host, not inside the plugin iframe', async ({
    connectedPage: page,
  }) => {
    await page
      .locator('.nav .toolbar-section button', {hasText: 'Open details'})
      .click();
    await expect(page.locator('.modal-layer .modal')).toHaveCount(1);
    // The iframe only ever shows the plugin's own in-frame UI.
    await expect(pluginFrame(page).locator('.modal')).toHaveCount(0);
    await expect(
      pluginFrame(page).getByRole('heading', {name: 'Example Notes Plugin'}),
    ).toBeVisible();
  });

  test('the modal close event round-trips to the plugin and hides it', async ({
    connectedPage: page,
  }) => {
    await page
      .locator('.nav .toolbar-section button', {hasText: 'Open details'})
      .click();
    const modal = page.locator('.modal-layer .modal');
    await expect(modal).toBeVisible();

    await modal.locator('.modal-close').click();
    await expect(page.locator('.modal-layer .modal')).toHaveCount(0);
  });

  test('a contributed in-modal button press also closes the modal', async ({
    connectedPage: page,
  }) => {
    await page
      .locator('.nav .toolbar-section button', {hasText: 'Open details'})
      .click();
    await page
      .locator('.modal-layer .modal')
      .getByRole('button', {name: 'Got it'})
      .click();
    await expect(page.locator('.modal-layer .modal')).toHaveCount(0);
  });

  test('modal open state stays in sync between the iframe UI and the chrome', async ({
    connectedPage: page,
  }) => {
    // Open from inside the iframe...
    await pluginFrame(page)
      .getByRole('button', {name: 'Open the modal'})
      .click();
    await expect(page.locator('.modal-layer .modal')).toBeVisible();
    // ...the in-iframe button label reflects the shared state...
    await expect(
      pluginFrame(page).getByRole('button', {name: 'Close the modal'}),
    ).toBeVisible();
    // ...and closing via the host updates it back.
    await page.locator('.modal-layer .modal .modal-close').click();
    await expect(page.locator('.modal-layer .modal')).toHaveCount(0);
    await expect(
      pluginFrame(page).getByRole('button', {name: 'Open the modal'}),
    ).toBeVisible();
  });
});
