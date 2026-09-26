import {expect, type APIRequestContext, type Page} from '@playwright/test';
import {test} from './fixtures';
import {blockChanges} from '../packages/layout-model/src/layout';

/**
 * The layout service (:5181): signed-in sessions (dev tokens), layouts per
 * workspace and role, edits restricted to editor roles, per-user state, and
 * every save validated server-side with the same model the editor uses.
 */
const SERVICE = 'http://localhost:5181';

/** The configured dev users, by role (see layout-service.config.yaml). */
const USER_FOR_ROLE: Record<string, string> = {admin: 'alice', pilot: 'pat', analyst: 'andy'};

async function signIn(request: APIRequestContext, user: string, workspace: string) {
  const res = await request.post(`${SERVICE}/v1/auth/dev-login`, {data: {user, workspace}});
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

/** An API session as the dev user holding `role`, in `workspace`. */
async function api(request: APIRequestContext, role: string, workspace: string) {
  const token = await signIn(request, USER_FOR_ROLE[role], workspace);
  const headers = {Authorization: `Bearer ${token}`};
  return {
    token,
    state: () => request.get(`${SERVICE}/v1/me/state`, {headers}),
    get: () => request.get(`${SERVICE}/v1/layouts`, {headers}),
    put: (view: unknown, changedBlocks: unknown[] = [], deletedBlocks: unknown[] = []) =>
      request.put(`${SERVICE}/v1/layouts/views/${(view as {id: string}).id}`, {
        headers,
        data: {view, changedBlocks, deletedBlocks},
      }),
    del: (id: string, rev?: number) =>
      request.delete(`${SERVICE}/v1/layouts/views/${id}${rev === undefined ? '' : `?rev=${rev}`}`, {
        headers,
      }),
  };
}

test.describe('layout service API', () => {
  test('roles see their own views; only editors may save', async ({request}, testInfo) => {
    const ws = `api-${testInfo.testId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const roles = await (await request.get(`${SERVICE}/v1/roles`)).json();
    expect(roles.roles.map((r: {id: string}) => r.id)).toEqual(['admin', 'pilot', 'analyst']);

    const pilot = await (await (await api(request, 'pilot', ws)).get()).json();
    expect(pilot.canEdit).toBe(false);
    expect(pilot.views.map((v: {id: string}) => v.id)).toEqual([
      'nav-detail',
      'portals',
      'two-maps',
      'actions',
    ]);
    const admin = await (await (await api(request, 'admin', ws)).get()).json();
    expect(admin.views.length).toBeGreaterThan(pilot.views.length);

    const view = admin.views.find((v: {id: string}) => v.id === 'quad');
    expect((await (await api(request, 'pilot', ws)).put(view)).status()).toBe(403);
    expect((await (await api(request, 'admin', ws)).put({...view, name: 'Quad!'})).status()).toBe(200);

    // Workspaces are isolated.
    const other = await (await (await api(request, 'admin', `${ws}-other`)).get()).json();
    expect(other.views.find((v: {id: string}) => v.id === 'quad').name).toBe('Quad');
  });

  test('saves are validated server-side (CEL types, wiring, geometry)', async ({request}, testInfo) => {
    const ws = `api-${testInfo.testId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const admin = await (await (await api(request, 'admin', ws)).get()).json();
    const nearby = structuredClone(admin.views.find((v: {id: string}) => v.id === 'nearby'));
    nearby.bindings[1].expr = 'histogram.selection'; // a Place into a bbox input
    nearby.bindings.push({blockId: 'places', input: 'nope', from: {blockId: 'histogram', output: 'selection'}});
    nearby.slots[0].colSpan = 3; // overlaps its neighbours

    const res = await (await api(request, 'admin', ws)).put(nearby);
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
  test('signing in as another user changes the available views and editing rights', async ({
    connectedPage: page,
  }) => {
    await openLayouts(page);
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();

    await page.getByLabel('Signed in as').selectOption('pat');
    await expect(page.getByLabel('Layout view').locator('option')).toHaveText([
      'Map + detail',
      'Portals (4-up)',
      'Two maps',
      'Quick actions',
    ]);
    await expect(page.getByRole('button', {name: /Edit layouts/})).toHaveCount(0);

    // The signed-in user is remembered across reloads.
    await page.reload();
    await expect(page.getByLabel('Signed in as')).toHaveValue('pat');
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

    await page.getByLabel('Signed in as').selectOption('pat');
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
    await expect(page.getByLabel('Signed in as')).toHaveCount(0);

    await page.getByRole('button', {name: /Edit layouts/}).click();
    await page.getByLabel('View name').fill('Offline edit');
    await page.getByRole('button', {name: 'Save view'}).click();
    await page.reload();
    await expect(page.getByLabel('Layout view')).toContainText('Offline edit');
  });
});

const workspaceFor = (testInfo: {testId: string}) =>
  `cc-${testInfo.testId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);

test.describe('optimistic concurrency (API)', () => {
  test('saves send only changed, new, never-saved and deleted blocks (pure)', () => {
    const base = {
      a: {id: 'a', appId: 'x', rev: 3},
      b: {id: 'b', appId: 'x', rev: 1},
      adhoc: {id: 'adhoc', appId: 'x'},
      gone: {id: 'gone', appId: 'x', rev: 5},
    };
    const next = {
      a: {id: 'a', appId: 'x', rev: 3}, // untouched
      b: {id: 'b', appId: 'x', rev: 1, label: 'B!'}, // edited
      adhoc: {id: 'adhoc', appId: 'x'}, // never saved
      fresh: {id: 'fresh', appId: 'x'}, // new in this edit
    };
    const {changed, deleted} = blockChanges(base, next);
    expect(changed.map((b) => b.id)).toEqual(['b', 'adhoc', 'fresh']);
    expect(deleted).toEqual([{id: 'gone', rev: 5}]);
  });

  test('a stale view save conflicts; a fresh one bumps the revision', async ({request}, testInfo) => {
    const svc = await api(request, 'admin', workspaceFor(testInfo));
    const {views} = await (await svc.get()).json();
    const quad = views.find((v: {id: string}) => v.id === 'quad');
    expect(quad.rev).toBe(1);

    const first = await svc.put({...quad, name: 'Alice’s quad'});
    expect(first.status()).toBe(200);
    const saved = (await first.json()).views.find((v: {id: string}) => v.id === 'quad');
    expect(saved.rev).toBe(2);

    // Bob still holds rev 1.
    const stale = await svc.put({...quad, name: 'Bob’s quad'});
    expect(stale.status()).toBe(409);
    const body = await stale.json();
    expect(body.conflicts).toEqual([
      {kind: 'view', id: 'quad', message: 'View “Alice’s quad” was changed by someone else'},
    ]);
    expect(body.current.views.find((v: {id: string}) => v.id === 'quad').name).toBe('Alice’s quad');

    // Deleting from a stale revision conflicts too.
    expect((await svc.del('quad', 1)).status()).toBe(409);
    expect((await svc.del('quad', 2)).status()).toBe(200);
  });

  test('edits only conflict when they touch the same view or block', async ({request}, testInfo) => {
    const svc = await api(request, 'admin', workspaceFor(testInfo));
    const {views, blocks} = await (await svc.get()).json();
    const byId = (id: string) => views.find((v: {id: string}) => v.id === id);
    const overview = blocks['world-map~overview'];

    // Different views, different blocks: both saves succeed.
    expect((await svc.put({...byId('quad'), name: 'A'})).status()).toBe(200);
    const detail = blocks['world-map~detail'];
    expect(
      (await svc.put(byId('two-maps'), [{...detail, label: 'Detail (B)'}])).status(),
    ).toBe(200);

    // Same block, from its original revision: the second edit conflicts.
    expect(
      (await svc.put(byId('explorer'), [{...overview, label: 'Overview (A)'}])).status(),
    ).toBe(200);
    const res = await svc.put(byId('nearby'), [{...overview, label: 'Overview (B)'}]);
    expect(res.status()).toBe(409);
    expect((await res.json()).conflicts).toEqual([
      {kind: 'block', id: 'world-map~overview', message: 'Block “Overview (A)” was changed by someone else'},
    ]);
  });
});

test.describe('optimistic concurrency (host)', () => {
  /** Two editors (tabs) on the same workspace, both editing the Quad view. */
  async function twoEditors(page: Page) {
    const workspace = await page.evaluate(() => localStorage.getItem('ff.workspace'));
    const other = await page.context().newPage();
    await other.addInitScript((ws) => localStorage.setItem('ff.workspace', ws!), workspace);
    for (const p of [page, other]) {
      await p.goto('/?mode=layout&view=quad');
      await expect(p.locator('.source-badge.service')).toBeVisible();
      await p.getByRole('button', {name: /Edit layouts/}).click();
    }
    // The first editor saves first.
    await page.getByLabel('View name').fill('Quad (first)');
    await page.getByRole('button', {name: 'Save view'}).click();
    await expect(page.getByRole('button', {name: /Edit layouts/})).toBeVisible();
    // The second saves from the now-stale revision.
    await other.getByLabel('View name').fill('Quad (second)');
    await other.getByRole('button', {name: 'Save view'}).click();
    const alert = other.getByRole('alert', {name: 'Edit conflict'});
    await expect(alert).toContainText('View “Quad (first)” was changed by someone else');
    return {other, alert};
  }

  test('reload latest discards my edit', async ({connectedPage: page}) => {
    const {other} = await twoEditors(page);
    await other.getByRole('button', {name: /Reload latest/}).click();
    await expect(other.getByRole('button', {name: /Edit layouts/})).toBeVisible();
    await expect(other.getByLabel('Layout view').locator('option:checked')).toHaveText('Quad (first)');
  });

  test('overwrite theirs saves my edit over theirs', async ({connectedPage: page}) => {
    const {other} = await twoEditors(page);
    await other.getByRole('button', {name: 'Overwrite theirs'}).click();
    await expect(other.getByRole('button', {name: /Edit layouts/})).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Layout view').locator('option:checked')).toHaveText('Quad (second)');
  });
});

test.describe('identity (signed tokens)', () => {
  test('the service trusts only a valid token', async ({request}, testInfo) => {
    const ws = workspaceFor(testInfo);
    // No token, or a tampered one: 401.
    expect((await request.get(`${SERVICE}/v1/layouts`)).status()).toBe(401);
    const pat = await api(request, 'pilot', ws);
    const [head, body, sig] = pat.token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.role = 'admin';
    const tampered = `${head}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect(
      (await request.get(`${SERVICE}/v1/layouts`, {headers: {Authorization: `Bearer ${tampered}`}})).status(),
    ).toBe(401);
    // Old-style role headers carry no weight: Pat is still a pilot.
    const res = await request.get(`${SERVICE}/v1/me`, {
      headers: {Authorization: `Bearer ${pat.token}`, 'X-FF-Role': 'admin'},
    });
    expect(await res.json()).toMatchObject({user: {id: 'pat', name: 'Pat'}, role: 'pilot', canEdit: false});
    // Unknown users can't sign in.
    expect(
      (await request.post(`${SERVICE}/v1/auth/dev-login`, {data: {user: 'mallory'}})).status(),
    ).toBe(400);
  });

  test('per-user state is private and stored per workspace', async ({request}, testInfo) => {
    const ws = workspaceFor(testInfo);
    const pat = await api(request, 'pilot', ws);
    const andy = await api(request, 'analyst', ws);
    const state = {liveByView: {quad: {id: 'quad', rev: 1}}, blocks: {}};
    const put = await request.put(`${SERVICE}/v1/me/state`, {
      headers: {Authorization: `Bearer ${pat.token}`},
      data: state,
    });
    expect(put.status()).toBe(204);
    expect(await (await pat.state()).json()).toEqual(state);
    expect(await (await andy.state()).json()).toEqual({liveByView: {}, blocks: {}});
  });
});

test.describe('per-user state (host)', () => {
  const statePut = (page: Page) =>
    page.waitForResponse((r) => r.url().endsWith('/v1/me/state') && r.request().method() === 'PUT');

  test('my ad-hoc changes follow me, and nobody else sees them', async ({connectedPage: page}) => {
    await page.goto('/?mode=layout&view=quad');
    await expect(page.locator('.source-badge.service')).toBeVisible();
    await expect(page.getByLabel('Signed in as')).toHaveValue('alice');

    // Swap two slots (an ad-hoc change) and add a block of my own.
    let saved = statePut(page);
    await page.getByLabel('Block in slot s2').selectOption('world-map');
    await saved;
    saved = statePut(page);
    await page.getByLabel('Block in slot s4').selectOption('new:world-map');
    await saved;

    await page.reload();
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('places');
    await expect(page.getByLabel('Block in slot s4')).toHaveValue('world-map~2');

    // Another user in the same workspace sees the approved layout.
    await page.getByLabel('Signed in as').selectOption('andy');
    await expect(page.getByLabel('Signed in as')).toHaveValue('andy');
    await expect(page.locator('.source-badge.service')).toBeVisible();
    await page.getByLabel('Layout view').selectOption('quad');
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('world-map');
    await expect(page.getByLabel('Block in slot s4')).toHaveValue('');

    // Back as Alice: still there. "Reset view" returns to the approved layout.
    await page.getByLabel('Signed in as').selectOption('alice');
    await expect(page.getByLabel('Signed in as')).toHaveValue('alice');
    await expect(page.locator('.source-badge.service')).toBeVisible();
    await page.getByLabel('Layout view').selectOption('quad');
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('places');
    saved = statePut(page);
    await page.getByRole('button', {name: 'Reset view'}).click();
    await saved;
    await page.reload();
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('world-map');
  });

  test('an ad-hoc copy is dropped when the approved view changes', async ({
    connectedPage: page,
    request,
  }) => {
    await page.goto('/?mode=layout&view=quad');
    await expect(page.locator('.source-badge.service')).toBeVisible();
    await page.getByLabel('Signed in as').selectOption('pat');
    // Wait until Pat's own layouts are showing (the pilot can't see Quad).
    await expect(page.getByLabel('Layout view').locator('option', {hasText: 'Quad'})).toHaveCount(0);
    await page.getByLabel('Layout view').selectOption('nav-detail');
    const saved = statePut(page);
    await page.getByLabel('Block in slot s2').selectOption('world-map');
    await saved;

    // Meanwhile an editor (Alice, via the API) changes the approved view,
    // bumping its revision — Pat's copy was based on the old one.
    const ws = await page.evaluate(() => localStorage.getItem('ff.workspace'));
    const alice = await api(request, 'admin', ws!);
    const {views} = await (await alice.get()).json();
    const navDetail = views.find((v: {id: string}) => v.id === 'nav-detail');
    expect((await alice.put({...navDetail, name: 'Map + detail v2'})).status()).toBe(200);

    await page.reload();
    await expect(page.getByLabel('Signed in as')).toHaveValue('pat');
    await expect(page.getByLabel('Layout view').locator('option:checked')).toHaveText('Map + detail v2');
    // Back to the approved layout: the map in s1, Places in s2.
    await expect(page.getByLabel('Block in slot s1')).toHaveValue('world-map');
    await expect(page.getByLabel('Block in slot s2')).toHaveValue('places');
  });
});
