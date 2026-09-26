import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';
import {renameReferences} from '../packages/layout-model/src/expressions';
import {
  DEFAULT_VIEWS,
  blockRenames,
  renameInView,
} from '../packages/layout-model/src/layout';
import {validatePortValue} from '../packages/layout-model/src/ports';

/**
 * Expression hygiene: renaming a block rewrites the expressions that refer to
 * it (everywhere), and values plugins publish are checked against their
 * declared port types before they're routed anywhere.
 */
test.describe('renaming references (pure)', () => {
  test('only variable references change; fields, strings and formatting are kept', () => {
    expect(renameReferences('bboxAround(histogram.selection, 1500)', 'histogram', 'hist')).toBe(
      'bboxAround(hist.selection, 1500)',
    );
    expect(
      renameReferences('x.histogram + "histogram.selection" + histogram.range.min', 'histogram', 'hist'),
    ).toBe('x.histogram + "histogram.selection" + hist.range.min');
    expect(renameReferences('nearby.?selection.orValue(histogram.selection)', 'nearby', 'close')).toBe(
      'close.?selection.orValue(histogram.selection)',
    );
    const multiline = '[\n  {"label": "a", "value": histogram.selection}\n]';
    expect(renameReferences(multiline, 'histogram', 'h')).toBe(
      '[\n  {"label": "a", "value": h.selection}\n]',
    );
    // Unparseable input is left alone.
    expect(renameReferences('histogram.selection(', 'histogram', 'h')).toBe('histogram.selection(');
  });

  test('views and registries', () => {
    const nearby = DEFAULT_VIEWS.find((v) => v.id === 'nearby')!;
    const renamed = renameInView(nearby, 'histogram', 'hist');
    expect(renamed.bindings!.map((b) => b.expr).filter(Boolean)).toEqual([
      'bboxAround(hist.selection, 1500)',
      'nearby.?selection.orValue(hist.selection)',
    ]);
    // Untouched views are returned as-is (so they aren't re-saved).
    const quad = DEFAULT_VIEWS.find((v) => v.id === 'quad')!;
    expect(renameInView(quad, 'histogram', 'hist')).toBe(quad);

    const base = {'world-map~overview': {id: 'world-map~overview', appId: 'world-map', name: 'overview'}};
    expect(
      blockRenames(base, {
        'world-map~overview': {...base['world-map~overview'], name: 'ov'},
        histogram: {id: 'histogram', appId: 'histogram', name: 'hist'},
      }),
    ).toEqual([
      {blockId: 'world-map~overview', from: 'overview', to: 'ov'},
      {blockId: 'histogram', from: 'histogram', to: 'hist'},
    ]);
  });
});

test.describe('published value checks (pure)', () => {
  test('values must match their declared port type', () => {
    const tokyo = {id: 'tokyo', name: 'Tokyo', latitude: 35.69, longitude: 139.69};
    expect(validatePortValue('place', tokyo)).toBeNull();
    expect(validatePortValue('place', null)).toBeNull();
    expect(validatePortValue('place', {...tokyo, latitude: 123})).toMatch(/latitude/);
    expect(validatePortValue('place', 'Tokyo')).toMatch(/expected a place/);
    expect(validatePortValue('bbox', {west: 0, south: 10, east: 5, north: 0})).toMatch(/south ≤ north/);
    expect(validatePortValue('bbox', {west: 0, south: 0, east: 5})).toMatch(/numeric/);
    expect(validatePortValue('range', {min: 2, max: 1})).toMatch(/min ≤ max/);
    expect(validatePortValue('number', Number.NaN)).toMatch(/finite/);
    expect(validatePortValue('string', 3)).toMatch(/string/);
    expect(validatePortValue('buttons', [{label: 'Go', command: {block: 'detail'}}])).toMatch(
      /button 0: expected \{block, command\}/,
    );
    expect(validatePortValue('buttons', [{label: 'Go', value: tokyo}])).toBeNull();
    expect(validatePortValue('any', {anything: [1, 2]})).toBeNull();
  });
});

async function openSettings(page: Page, view: string, slot: string) {
  await page.goto(`/?mode=layout&view=${view}`);
  await expect(page.locator('.source-badge.service')).toBeVisible();
  await page.getByRole('button', {name: /Edit layouts/}).click();
  await page.getByLabel(`Settings for slot ${slot}`).click();
}

test.describe('renaming a block (host + service)', () => {
  test('rewrites references in the view being edited straight away', async ({connectedPage: page}) => {
    await openSettings(page, 'nearby', 's3');
    const name = page.getByLabel('Name in expressions');
    await expect(name).toHaveValue('nearby');

    // Invalid or taken names are refused.
    await name.fill('9lives');
    await expect(page.getByText('Use letters, digits and _')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Rename'})).toBeDisabled();
    await name.fill('histogram');
    await expect(page.getByText('Another block already uses this name')).toBeVisible();

    await name.fill('close_by');
    await page.getByRole('button', {name: 'Rename'}).click();
    await expect(page.locator('.slot-edit-wire', {hasText: 'place ='})).toContainText(
      'close_by.?selection.orValue(histogram.selection)',
    );
  });

  test('rewrites references in other views when saved', async ({connectedPage: page}) => {
    // Rename the histogram block from the Explorer view, where it has no expressions…
    await openSettings(page, 'explorer', 's2');
    await page.getByLabel('Name in expressions').fill('hist');
    await page.getByRole('button', {name: 'Rename'}).click();
    await page.getByRole('button', {name: 'Save view'}).click();
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();

    // …and the Nearby view's expressions were rewritten by the service.
    await openSettings(page, 'nearby', 's3');
    await expect(page.getByLabel('Expression for Filter to area')).toHaveValue(
      'bboxAround(hist.selection, 1500)',
    );
    await page.getByRole('button', {name: 'Cancel'}).click();

    // And they still work.
    const frame = (id: string) => page.frameLocator(`iframe[title="${id}"]`);
    await frame('histogram').getByRole('button', {name: /^Tokyo/}).click();
    await expect(
      frame('histogram~nearby').getByRole('list', {name: 'Matching cities'}),
    ).toContainText('Osaka');
  });
});
