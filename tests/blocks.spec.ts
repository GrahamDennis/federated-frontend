import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';

/**
 * Blocks: several configured instances of the same plugin in one layout, each
 * its own iframe + thread, with per-instance settings authored in edit mode.
 */
const frame = (page: Page, instanceId: string) =>
  page.frameLocator(`iframe[title="${instanceId}"]`);

test.describe('blocks (multiple instances + settings)', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=two-maps');
    await expect(page.getByLabel('Layout view')).toHaveValue('two-maps');
  });

  test('two instances of the map run side by side with their own settings', async ({
    page,
  }) => {
    const overview = frame(page, 'world-map~overview');
    const detail = frame(page, 'world-map~detail');
    await expect(overview.locator('.map-title')).toContainText('Overview');
    await expect(detail.locator('.map-title')).toContainText('Detail');
    // The detail map is configured without city buttons.
    await expect(overview.getByRole('button', {name: 'Tokyo'})).toBeVisible();
    await expect(detail.locator('.map-buttons')).toHaveCount(0);
  });

  test('instances cohere through the shared selection', async ({page}) => {
    await frame(page, 'world-map~overview').getByRole('button', {name: 'Tokyo'}).click();
    // The detail map follows the selection; Places reflects it.
    await expect(frame(page, 'world-map~detail').locator('.map-status')).toHaveText(
      'Flying to Tokyo',
    );
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Tokyo');
  });

  test('the palette tells same-app commands apart by instance', async ({page}) => {
    await page.getByRole('button', {name: /Search & commands/}).click();
    const tokyo = page.locator('.palette-item', {hasText: 'Map: Fly to Tokyo'});
    await expect(tokyo).toHaveCount(2);
    await expect(tokyo.nth(0).locator('.palette-item-subtitle')).toContainText('Overview map');
    await expect(tokyo.nth(1).locator('.palette-item-subtitle')).toContainText('Detail map');
  });

  test('a user can add another instance of an app to a slot', async ({page}) => {
    await page.getByLabel('Layout view').selectOption('quad');
    await expect(page.locator('iframe[title="world-map"]')).toBeVisible();
    await page.getByLabel('Block in slot s4').selectOption('new:world-map');

    await expect(page.locator('iframe[title="world-map~2"]')).toBeVisible();
    await expect(page.locator('iframe[title="world-map"]')).toBeVisible();
    await expect(page.getByLabel('Block in slot s4')).toHaveValue('world-map~2');
    await expect(frame(page, 'world-map~2').locator('.map-badge')).toHaveText('hosted');
  });

  test('block settings are edited live in edit mode and saved with the view', async ({
    page,
  }) => {
    const overview = frame(page, 'world-map~overview');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s1').click();

    const panel = page.getByRole('complementary', {name: 'Block settings'});
    await expect(panel).toContainText('world-map~overview');
    await panel.getByLabel('Title').fill('Recon');
    await panel.getByLabel('Show city buttons').uncheck();
    await panel.getByLabel('Block name').fill('Recon map');

    // The running plugin is told about the change over its thread — no reload.
    await expect(overview.locator('.map-title')).toContainText('Recon');
    await expect(overview.locator('.map-buttons')).toHaveCount(0);

    await page.getByRole('button', {name: 'Save view'}).click();
    await page.reload();
    await expect(frame(page, 'world-map~overview').locator('.map-title')).toContainText(
      'Recon',
    );
    await expect(page.getByLabel('Block in slot s1')).toContainText('Recon map');
  });

  test('cancelling edit mode discards setting changes', async ({page}) => {
    const overview = frame(page, 'world-map~overview');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s1').click();
    await page.getByLabel('Title').fill('Scratch');
    await expect(overview.locator('.map-title')).toContainText('Scratch');
    await page.getByRole('button', {name: 'Cancel'}).click();
    await expect(overview.locator('.map-title')).toContainText('Overview');
  });
});
