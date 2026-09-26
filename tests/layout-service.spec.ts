import {expect, type APIRequestContext, type Page} from '@playwright/test';
import {test} from './fixtures';

/**
 * The layout service (:5181): layouts per workspace and role, edits restricted
 * to editor roles, and every save validated server-side with the same model the
 * editor uses (CEL type checks, wiring, geometry).
 */
const SERVICE = 'http://localhost:5181';

function api(request: APIRequestContext, role: string, workspace: string) {
  const headers = {'X-FF-Role': role, 'X-FF-Workspace': workspace};
  return {
    get: () => request.get(`${SERVICE}/v1/layouts`, {headers}),
    put: (view: unknown, blocks: unknown) =>
      request.put(`${SERVICE}/v1/layouts/views/${(view as {id: string}).id}`, {
        headers,
        data: {view, blocks},
      }),
  };
}

test.describe('layout service API', () => {
  test('roles see their own views; only editors may save', async ({request}, testInfo) => {
    const ws = `api-${testInfo.testId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const roles = await (await request.get(`${SERVICE}/v1/roles`)).json();
    expect(roles.roles.map((r: {id: string}) => r.id)).toEqual(['admin', 'pilot', 'analyst']);

    const pilot = await (await api(request, 'pilot', ws).get()).json();
    expect(pilot.canEdit).toBe(false);
    expect(pilot.views.map((v: {id: string}) => v.id)).toEqual([
      'nav-detail',
      'portals',
      'two-maps',
      'actions',
    ]);
    const admin = await (await api(request, 'admin', ws).get()).json();
    expect(admin.views.length).toBeGreaterThan(pilot.views.length);

    const view = admin.views.find((v: {id: string}) => v.id === 'quad');
    expect((await api(request, 'pilot', ws).put(view, admin.blocks)).status()).toBe(403);
    expect((await api(request, 'admin', ws).put({...view, name: 'Quad!'}, admin.blocks)).status()).toBe(200);

    // Workspaces are isolated.
    const other = await (await api(request, 'admin', `${ws}-other`).get()).json();
    expect(other.views.find((v: {id: string}) => v.id === 'quad').name).toBe('Quad');
  });

  test('saves are validated server-side (CEL types, wiring, geometry)', async ({request}, testInfo) => {
    const ws = `api-${testInfo.testId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const admin = await (await api(request, 'admin', ws).get()).json();
    const nearby = structuredClone(admin.views.find((v: {id: string}) => v.id === 'nearby'));
    nearby.bindings[1].expr = 'histogram.selection'; // a Place into a bbox input
    nearby.bindings.push({blockId: 'places', input: 'nope', from: {blockId: 'histogram', output: 'selection'}});
    nearby.slots[0].colSpan = 3; // overlaps its neighbours

    const res = await api(request, 'admin', ws).put(nearby, admin.blocks);
    expect(res.status()).toBe(422);
    const {errors} = await res.json();
    const messages = errors.map((e: {path: string; message: string}) => `${e.path}: ${e.message}`);
    expect(messages).toContain(
      'bindings.histogram~nearby.viewport: Returns Place, but this input expects BBox',
    );
    expect(messages).toContain('bindings.places.nope: “places” has no input “nope”');
    expect(messages.some((m: string) => m.startsWith('slots.s1: Overlaps'))).toBe(true);
  });
});

const openLayouts = async (page: Page) => {
  await page.goto('/?mode=layout');
  await expect(page.locator('.source-badge.service')).toHaveText('● Shared');
};

test.describe('layout service in the host', () => {
  test('switching role changes the available views and editing rights', async ({
    connectedPage: page,
  }) => {
    await openLayouts(page);
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();

    await page.getByLabel('Role').selectOption('pilot');
    await expect(page.getByLabel('Layout view').locator('option')).toHaveText([
      'Map + detail',
      'Portals (4-up)',
      'Two maps',
      'Quick actions',
    ]);
    await expect(page.getByRole('button', {name: /Edit layouts/})).toHaveCount(0);

    // The role is remembered across reloads.
    await page.reload();
    await expect(page.getByLabel('Role')).toHaveValue('pilot');
  });

  test('an editor decides which roles see a view', async ({connectedPage: page}) => {
    await openLayouts(page);
    await page.getByLabel('Layout view').selectOption('quad');
    await page.getByRole('button', {name: /Edit layouts/}).click();
    const visibility = page.getByRole('group', {name: 'Visible to'});
    await expect(visibility.getByLabel('Analyst')).toBeChecked();
    await visibility.getByLabel('Pilot').check();
    await page.getByRole('button', {name: 'Save view'}).click();
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();

    await page.getByLabel('Role').selectOption('pilot');
    await expect(page.getByLabel('Layout view').locator('option')).toContainText(['Quad']);
  });

  test('the server rejects an invalid save and the draft stays open', async ({
    connectedPage: page,
  }) => {
    await page.goto('/?mode=layout&view=nearby');
    await expect(page.locator('.source-badge.service')).toBeVisible();
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s3').click();
    // The editor already flags it; the server independently refuses it.
    await page.getByLabel('Expression for Filter to area').fill('histogram.selection');
    await page.getByRole('button', {name: 'Save view'}).click();

    const errors = page.getByRole('alert', {name: 'Save errors'});
    await expect(errors).toContainText('Returns Place, but this input expects BBox');
    await expect(page.getByRole('button', {name: 'Save view'})).toBeVisible();

    // Fix it and the save goes through.
    await page.getByLabel('Expression for Filter to area').fill('bboxAround(histogram.selection, 800)');
    await page.getByRole('button', {name: 'Save view'}).click();
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();
    await page.reload();
    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('Settings for slot s3').click();
    await expect(page.getByLabel('Expression for Filter to area')).toHaveValue(
      'bboxAround(histogram.selection, 800)',
    );
  });

  test('without the service, layouts fall back to this browser', async ({connectedPage: page}) => {
    await page.route(`${SERVICE}/**`, (route) => route.abort());
    await page.goto('/?mode=layout');
    await expect(page.locator('.source-badge.local')).toHaveText('○ Local only');
    await expect(page.getByLabel('Role')).toHaveCount(0);

    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('View name').fill('Offline edit');
    await page.getByRole('button', {name: 'Save view'}).click();
    await page.reload();
    await expect(page.getByLabel('Layout view')).toContainText('Offline edit');
  });
});
