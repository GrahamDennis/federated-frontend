import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {serve} from '@hono/node-server';
import {Hono, type Context} from 'hono';
import {cors} from 'hono/cors';
import {validateLayout, type BlockRegistry, type LayoutView} from '@ff/layout-model';
import {loadConfig} from './config';
import {WorkspaceStore, isWorkspaceId, type Workspace} from './store';
import {AppCatalog} from './apps';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.FF_LAYOUT_CONFIG ?? join(PKG_DIR, 'layout-service.config.yaml');
const PORT = Number(process.env.PORT ?? 5181);

const config = await loadConfig(CONFIG_PATH);
const store = new WorkspaceStore(
  process.env.FF_LAYOUT_EPHEMERAL ? null : resolve(PKG_DIR, config.dataDir),
  config.seedViewRoles ?? {},
);
const catalog = new AppCatalog(config.registry);

/**
 * Who's asking. PROTOTYPE: the role and workspace come from request headers
 * that nothing authenticates — a real deployment derives them from a session.
 */
function caller(c: Context) {
  const role = c.req.header('X-FF-Role') ?? config.defaultRole;
  const workspace = c.req.header('X-FF-Workspace') ?? 'default';
  const roleConfig = config.roles[role];
  if (!roleConfig) return {error: c.json({error: `Unknown role “${role}”`}, 400)};
  if (!isWorkspaceId(workspace)) return {error: c.json({error: 'Invalid workspace id'}, 400)};
  return {role, workspace, canEdit: Boolean(roleConfig.canEdit)};
}

/** A workspace as one role sees it: editors see every view, others their own. */
function visibleTo(ws: Workspace, role: string, canEdit: boolean) {
  return {
    role,
    canEdit,
    views: canEdit ? ws.views : ws.views.filter((v) => v.roles?.includes(role)),
    blocks: ws.blocks,
  };
}

const app = new Hono();
app.use(
  '/v1/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-FF-Role', 'X-FF-Workspace'],
  }),
);

app.get('/', (c) =>
  c.json({service: '@ff/layout-service', endpoints: ['/v1/roles', '/v1/layouts', '/v1/validate']}),
);

app.get('/v1/roles', (c) =>
  c.json({
    defaultRole: config.defaultRole,
    roles: Object.entries(config.roles).map(([id, r]) => ({id, label: r.label, canEdit: Boolean(r.canEdit)})),
  }),
);

app.get('/v1/layouts', async (c) => {
  const who = caller(c);
  if ('error' in who) return who.error;
  return c.json(visibleTo(await store.get(who.workspace), who.role, who.canEdit));
});

/** Validate a view + block registry against the plugins that exist. */
async function validate(view: LayoutView, blocks: BlockRegistry) {
  return validateLayout(view, blocks, await catalog.apps());
}

app.post('/v1/validate', async (c) => {
  const {view, blocks} = await c.req.json<{view: LayoutView; blocks: BlockRegistry}>();
  try {
    return c.json({errors: await validate(view, blocks ?? {})});
  } catch (error) {
    return c.json({error: `Can’t reach the plugin registry: ${error}`}, 503);
  }
});

app.put('/v1/layouts/views/:id', async (c) => {
  const who = caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const {view, blocks} = await c.req.json<{view: LayoutView; blocks: BlockRegistry}>();
  if (view?.id !== c.req.param('id')) return c.json({error: 'View id doesn’t match the URL'}, 400);
  let errors;
  try {
    errors = await validate(view, blocks ?? {});
  } catch (error) {
    return c.json({error: `Can’t reach the plugin registry to validate: ${error}`}, 503);
  }
  if (errors.length > 0) return c.json({error: 'Layout is invalid', errors}, 422);

  const ws = await store.get(who.workspace);
  const next: Workspace = {
    blocks: blocks ?? {},
    views: ws.views.some((v) => v.id === view.id)
      ? ws.views.map((v) => (v.id === view.id ? view : v))
      : [...ws.views, view],
  };
  await store.put(who.workspace, next);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

app.delete('/v1/layouts/views/:id', async (c) => {
  const who = caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const ws = await store.get(who.workspace);
  const views = ws.views.filter((v) => v.id !== c.req.param('id'));
  if (views.length === ws.views.length) return c.json({error: 'No such view'}, 404);
  if (views.length === 0) return c.json({error: 'Can’t delete the last view'}, 409);
  const next = {...ws, views};
  await store.put(who.workspace, next);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

app.post('/v1/layouts/reset', async (c) => {
  const who = caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const next = store.seed();
  await store.put(who.workspace, next);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

serve({fetch: app.fetch, port: PORT}, ({port}) => {
  console.log(`[layouts] listening on http://localhost:${port} (registry: ${config.registry})`);
});
