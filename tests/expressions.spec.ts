import {expect, type Page} from '@playwright/test';
import {test} from './fixtures';
import {
  ExprError,
  evaluate,
  evaluateSource,
  inferType,
  parseExpr,
  refsOf,
} from '../packages/host/src/expressions';
import {bindingSources, DEFAULT_VIEWS, resolveInputs} from '../packages/host/src/layout';

const tokyo = {id: 'tokyo', name: 'Tokyo', latitude: 35.69, longitude: 139.69};
const osaka = {id: 'osaka', name: 'Osaka', latitude: 34.69, longitude: 135.5};
const outputs: Record<string, Record<string, unknown>> = {
  histogram: {selection: tokyo},
  'world-map~overview': {viewport: {west: 100, south: 0, east: 150, north: 50}},
};
const outputOf = (b: string, o: string) => (outputs[b]?.[o] ?? undefined) as never;
const run = (src: string) => evaluate(parseExpr(src), outputOf);

test.describe('expression language (pure)', () => {
  test('parses references with block ids containing ~ and -', () => {
    expect(parseExpr('world-map~overview.viewport.west')).toEqual({
      kind: 'ref',
      blockId: 'world-map~overview',
      output: 'viewport',
      path: ['west'],
    });
    expect(run('world-map~overview.viewport.west')).toBe(100);
  });

  test('literals, arithmetic and logic', () => {
    expect(run('add(1, 2, 3)')).toBe(6);
    expect(run('sub(10, -2.5)')).toBe(12.5);
    expect(run('div(1, 0)')).toBeNull();
    expect(run("if(gt(3, 2), 'yes', 'no')")).toBe('yes');
    expect(run('and(true, not(false))')).toBe(true);
    expect(run('round(3.14159, 2)')).toBe(3.14);
  });

  test('null propagates, except through null-aware functions', () => {
    expect(run('add(missing.value, 1)')).toBeNull();
    expect(run('coalesce(missing.value, histogram.selection.name)')).toBe('Tokyo');
    expect(run('isNull(missing.value)')).toBe(true);
  });

  test('geography helpers', () => {
    const box = run('bboxAround(histogram.selection, 1500)') as any;
    // ~13.5° of latitude either side for 1,500 km.
    expect(box.north - box.south).toBeCloseTo((2 * 1500) / 111.32, 3);
    expect(box.west).toBeLessThan(tokyo.longitude);
    const km = evaluate(parseExpr('distanceKm(a.p, b.p)'), (b) =>
      (b === 'a' ? tokyo : osaka) as never,
    ) as unknown as number;
    expect(km).toBeGreaterThan(380);
    expect(km).toBeLessThan(420);
    expect(run('intersect(bbox(0, 0, 10, 10), bbox(20, 20, 30, 30))')).toBeNull();
    expect(run('center(bbox(0, 0, 10, 20))')).toMatchObject({latitude: 10, longitude: 5});
  });

  test('parse errors are positioned and descriptive', () => {
    const cases: [string, RegExp][] = [
      ['bboxAround(histogram.selection', /Expected '\)'/],
      ['nope(1)', /Unknown function 'nope'/],
      ['bboxAround(1)', /takes 2 arguments/],
      ['histogram', /refer to an output as block.output/],
      ['1 2', /Unexpected input/],
    ];
    for (const [src, message] of cases) {
      let error: unknown;
      try {
        parseExpr(src);
      } catch (e) {
        error = e;
      }
      expect(error, src).toBeInstanceOf(ExprError);
      expect((error as ExprError).message, src).toMatch(message);
    }
    expect(evaluateSource('broken(', outputOf)).toBeNull();
  });

  test('type inference', () => {
    const portType = (b: string, o: string) =>
      ({'histogram.selection': 'place', 'm.viewport': 'bbox'})[`${b}.${o}`];
    const type = (src: string) => inferType(parseExpr(src), portType);
    expect(type('bboxAround(histogram.selection, 5)')).toBe('bbox');
    expect(type('coalesce(x.y, histogram.selection)')).toBe('place');
    expect(type('distanceKm(histogram.selection, histogram.selection)')).toBe('number');
    expect(type('histogram.selection.name')).toBe('any');
  });

  test('bindings resolve through expressions and report what they read', () => {
    const nearby = DEFAULT_VIEWS.find((v) => v.id === 'nearby')!;
    const inputs = resolveInputs(nearby, 'places', outputOf);
    expect(inputs.place).toEqual(tokyo);
    const binding = nearby.bindings!.find((b) => b.blockId === 'places')!;
    expect(bindingSources(binding).map((s) => s.blockId)).toEqual([
      'histogram~nearby',
      'histogram',
    ]);
    expect(refsOf(parseExpr('add(a.x, b.y)'))).toHaveLength(2);
  });
});

const frame = (page: Page, instanceId: string) =>
  page.frameLocator(`iframe[title="${instanceId}"]`);

test.describe('derived expressions (Nearby view)', () => {
  test.beforeEach(async ({connectedPage: page}) => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('/?mode=layout&view=nearby');
    await expect(page.getByLabel('Layout view')).toHaveValue('nearby');
  });

  test('a computed viewport shows cities near the pick', async ({page}) => {
    const nearby = frame(page, 'histogram~nearby');
    await expect(nearby.locator('.histogram-scope')).toContainText('Waiting for an area');

    await frame(page, 'histogram').getByRole('button', {name: /^Tokyo/}).click();

    const list = nearby.getByRole('list', {name: 'Matching cities'});
    await expect(list).toContainText('Osaka');
    await expect(list).toContainText('Seoul');
    await expect(list).not.toContainText('London');
    // coalesce(): nothing picked nearby yet, so Places falls back to the main pick…
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Tokyo');
    // …and follows the nearby pick once there is one.
    await list.getByRole('button', {name: /^Osaka/}).click();
    await expect(frame(page, 'places').locator('.place-detail h2')).toHaveText('Osaka');
  });

  test('editing an expression: errors, inferred type, and the result live', async ({page}) => {
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s3').click();
    const editor = page.getByLabel('Expression for Filter to area');
    await expect(editor).toHaveValue('bboxAround(histogram.selection, 1500)');
    const status = page.getByRole('complementary', {name: 'Block settings'}).getByRole('status');
    await expect(status).toContainText('→ bbox');

    await editor.fill('bboxAround(histogram.selection');
    await expect(status).toContainText("Expected ')'");

    await editor.fill('histogram.selection');
    await expect(status).toContainText('input expects bbox');

    // A tighter radius, applied live to the running histogram (no Save needed
    // to preview; Save persists it).
    await editor.fill('bboxAround(histogram.selection, 500)');
    await expect(status).toContainText('→ bbox');
    await page.getByRole('button', {name: 'Save view'}).click();
    await frame(page, 'histogram').getByRole('button', {name: /^Tokyo/}).click();
    const list = frame(page, 'histogram~nearby').getByRole('list', {name: 'Matching cities'});
    await expect(list).toContainText('Osaka');
    await expect(list).not.toContainText('Seoul');
  });

  test('switching an input between a direct source and an expression', async ({page}) => {
    await page.goto('/?mode=layout&view=explorer');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s4').click();
    await page.getByLabel('Input Place to show').selectOption({label: 'ƒ Expression…'});
    // Seeded from the direct source it replaces.
    await expect(page.getByLabel('Expression for Place to show')).toHaveValue(
      'histogram.selection',
    );
    await expect(page.locator('.slot-edit-wire', {hasText: 'place ='})).toContainText(
      'histogram.selection',
    );
    // Clicking an available output inserts a reference.
    await page.getByLabel('Expression for Place to show').fill('coalesce(');
    await page.getByRole('button', {name: 'world-map~overview.selection'}).click();
    await expect(page.getByLabel('Expression for Place to show')).toHaveValue(
      'coalesce(world-map~overview.selection',
    );
  });
});
