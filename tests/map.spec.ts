import {test as base, expect} from '@playwright/test';
import {test, pluginFrame} from './fixtures';

const mapFrame = (page: import('@playwright/test').Page) =>
  page.frameLocator('iframe[title="world-map"]');

/**
 * The MapLibre plugin, hosted. It uses only the capability API (commands +
 * toasts) — no remote-dom — and enhances the shell when present.
 */
test.describe('map plugin (hosted)', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.locator('.app-rail-item', {hasText: 'World Map'}).click();
    // The map app's panel renders independently of WebGL/network.
    await expect(mapFrame(page).locator('.map-panel')).toBeVisible();
  });

  test('renders the map app and detects it is hosted', async ({
    connectedPage: page,
  }) => {
    await expect(mapFrame(page).locator('.map-badge')).toHaveText('hosted');
    await expect(
      mapFrame(page).getByRole('button', {name: 'Tokyo'}),
    ).toBeVisible();
  });

  test('flying to a city raises a host toast', async ({connectedPage: page}) => {
    await mapFrame(page).getByRole('button', {name: 'Tokyo'}).click();
    await expect(page.locator('.toast-region .toast')).toHaveText(
      '🗺️ Flying to Tokyo',
    );
  });

  test('registers fly-to commands in the host palette', async ({
    connectedPage: page,
  }) => {
    await page.locator('.cmdk-button').click();
    await expect(
      page.locator('.palette-item', {hasText: 'Map: Fly to Sydney'}),
    ).toBeVisible();

    await page
      .locator('.palette-item', {hasText: 'Map: Fly to Sydney'})
      .click();
    await expect(page.locator('.toast-region .toast')).toHaveText(
      '🗺️ Flying to Sydney',
    );
  });

  test('the Notes plugin has no map commands (commands are per-app)', async ({
    connectedPage: page,
  }) => {
    await page.locator('.app-rail-item', {hasText: 'Example Notes'}).click();
    // Wait for the notes iframe to be the visible one again.
    await expect(pluginFrame(page).locator('.app h1')).toBeVisible();
    await page.locator('.cmdk-button').click();
    await expect(
      page.locator('.palette-item', {hasText: 'Map: Fly to'}),
    ).toHaveCount(0);
  });
});

/**
 * The same map plugin loaded directly: the map + controls still work; host-only
 * enhancements (toasts, ⌘K commands) are simply absent.
 */
base.describe('map plugin (standalone)', () => {
  base.beforeEach(async ({page}) => {
    await page.goto('http://localhost:5175/');
    await expect(page.locator('.map-panel')).toBeVisible();
  });

  base('detects standalone and still offers the controls', async ({page}) => {
    await expect(page.locator('.map-badge')).toHaveText('standalone');
    await expect(page.getByRole('button', {name: 'London'})).toBeVisible();
  });

  base('flying updates the in-map status (no host required)', async ({page}) => {
    await page.getByRole('button', {name: 'London'}).click();
    await expect(page.locator('.map-status')).toHaveText('Flying to London');
  });
});
