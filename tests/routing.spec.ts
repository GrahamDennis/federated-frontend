import {test, expect} from '@playwright/test';

const HOST = 'http://localhost:5173/';

const ctxParam = (place: {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  zoom?: number;
}) => encodeURIComponent(JSON.stringify({selectedPlace: place}));

const url = (page: import('@playwright/test').Page) => new URL(page.url());

/**
 * The workspace (primary app, docked detail, shared selection) is URL-addressable,
 * so a composed view is shareable / bookmarkable / reloadable.
 */
test.describe('workspace URL routing', () => {
  test('a deep link restores app, docked detail panel, and selection', async ({
    page,
  }) => {
    const ctx = ctxParam({
      id: 'tokyo',
      name: 'Tokyo',
      longitude: 139.69,
      latitude: 35.69,
      zoom: 9,
    });
    await page.goto(`${HOST}?app=world-map&detail=places&ctx=${ctx}`);

    // Primary = map, detail panel docked = places, both showing the selection.
    await expect(
      page.frameLocator('iframe[title="world-map"]').locator('.map-panel'),
    ).toBeVisible();
    await expect(page.locator('.panes.has-detail')).toBeVisible();
    await expect(
      page.frameLocator('iframe[title="places"]').locator('.place-detail h2'),
    ).toHaveText('Tokyo');
  });

  test('switching the active app is reflected in the URL', async ({page}) => {
    await page.goto(HOST);
    await page.locator('.app-rail-item', {hasText: 'World Map'}).click();
    await expect
      .poll(() => url(page).searchParams.get('app'))
      .toBe('world-map');
  });

  test('selecting a place writes the selection to the URL', async ({page}) => {
    await page.goto(`${HOST}?app=world-map`);
    await page
      .frameLocator('iframe[title="world-map"]')
      .getByRole('button', {name: 'Sydney'})
      .click();

    await expect
      .poll(() => url(page).searchParams.get('ctx'))
      .toContain('sydney');
  });

  test('docking the detail panel is reflected in the URL', async ({page}) => {
    await page.goto(`${HOST}?app=world-map`);
    await page.getByRole('button', {name: /Places panel/}).click();
    await expect
      .poll(() => url(page).searchParams.get('detail'))
      .toBe('places');
  });

  test('the default app is omitted from the URL (clean by default)', async ({
    page,
  }) => {
    await page.goto(HOST);
    // Example Notes is the default primary app, so no ?app= is added.
    await expect
      .poll(() => url(page).searchParams.get('app'))
      .toBeNull();
  });
});
