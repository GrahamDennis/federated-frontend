import {test as base, expect, type Page} from '@playwright/test';
import {test} from './fixtures';

const mapFrame = (page: Page) =>
  page.frameLocator('iframe[title="world-map"]');
const placesFrame = (page: Page) =>
  page.frameLocator('iframe[title="places"]');
const detailToggle = (page: Page) =>
  page.getByRole('button', {name: /Places panel/});

/**
 * The hub-and-spokes payoff: the map (hub) and the Places panel (subordinate
 * detail) composed in one workspace, cohering around a host-mediated shared
 * selection — something native tabs can't do.
 */
test.describe('shared context (map hub + Places detail)', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.locator('.app-rail-item', {hasText: 'World Map'}).click();
    await expect(mapFrame(page).locator('.map-panel')).toBeVisible();
  });

  test('Places is a companion, not a rail app', async ({
    connectedPage: page,
  }) => {
    await expect(
      page.locator('.app-rail-item .app-rail-name'),
    ).not.toContainText(['Places']);
    // ...but it's offered as a dockable detail panel of the map.
    await expect(detailToggle(page)).toBeVisible();
  });

  test('docking the Places panel shows both apps side by side', async ({
    connectedPage: page,
  }) => {
    await detailToggle(page).click();
    await expect(page.locator('.panes.has-detail')).toBeVisible();
    await expect(page.locator('iframe[title="world-map"]')).toBeVisible();
    await expect(page.locator('iframe[title="places"]')).toBeVisible();
    await expect(placesFrame(page).locator('.places-badge')).toHaveText(
      'detail',
    );
  });

  test('selecting a city in the map reflects in the Places detail', async ({
    connectedPage: page,
  }) => {
    await detailToggle(page).click();
    await expect(placesFrame(page).locator('.places-empty')).toBeVisible();

    await mapFrame(page).getByRole('button', {name: 'Tokyo'}).click();

    await expect(placesFrame(page).locator('.place-detail h2')).toHaveText(
      'Tokyo',
    );
    await expect(placesFrame(page).locator('.place-coords')).toContainText(
      'Latitude',
    );
  });

  test('clearing the selection from Places propagates back', async ({
    connectedPage: page,
  }) => {
    await detailToggle(page).click();
    await mapFrame(page).getByRole('button', {name: 'Sydney'}).click();
    await expect(placesFrame(page).locator('.place-detail h2')).toHaveText(
      'Sydney',
    );

    await placesFrame(page)
      .getByRole('button', {name: 'Clear selection'})
      .click();
    await expect(placesFrame(page).locator('.places-empty')).toBeVisible();
  });

  test('the command palette spans both composed apps', async ({
    connectedPage: page,
  }) => {
    await detailToggle(page).click();
    // Wait until Places has registered its command (its iframe is live).
    await expect(placesFrame(page).locator('.places-header')).toBeVisible();

    await page.locator('.cmdk-button').click();
    await expect(
      page.locator('.palette-item', {hasText: 'Map: Fly to Tokyo'}),
    ).toBeVisible();
    await expect(
      page.locator('.palette-item', {hasText: 'Places: Clear selection'}),
    ).toBeVisible();
  });
});

base.describe('Places standalone', () => {
  base('detects standalone and explains it needs the shared context', async ({
    page,
  }) => {
    await page.goto('http://localhost:5176/');
    await expect(page.locator('.places-badge')).toHaveText('standalone');
    await expect(page.locator('.places-empty')).toContainText('standalone');
  });
});
