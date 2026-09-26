import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {serve} from '@hono/node-server';
import {Hono, type Context} from 'hono';
import {cors} from 'hono/cors';
import {streamSSE} from 'hono/streaming';
import {validateLayout, type Block, type BlockRegistry, type LayoutView} from '@ff/layout-model';
import {loadConfig} from './config';
import {WorkspaceStore, isWorkspaceId, type UserState, type Workspace} from './store';
import {issueToken, verifyBearer} from './auth';
import {EventHub} from './events';
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
const hub = new EventHub();

/**
 * Tell everyone in a workspace that layouts changed. Clients refetch (so role
 * filtering stays on the server) and re-check their drafts and ad-hoc copies.
 */
function layoutsChanged(workspace: string, by: {user: string; name: string}, views: string[]) {
  hub.broadcast(workspace, {event: 'layouts-changed', data: {views, by: {id: by.user, name: by.name}}});
}

/**
 * Who's asking: taken *only* from the verified token's claims (user, role,
 * workspace) — never from anything else the client sends.
 */
async function caller(c: Context) {
  const claims = await verifyBearer(config.auth, c.req.header('Authorization'));
  if (!claims) return {error: c.json({error: 'Sign in required'}, 401)};
  const roleConfig = config.roles[claims.role];
  if (!roleConfig || !isWorkspaceId(claims.ws)) return {error: c.json({error: 'Invalid token'}, 401)};
  return {
    user: claims.sub,
    name: claims.name,
    role: claims.role,
    workspace: claims.ws,
    canEdit: Boolean(roleConfig.canEdit),
  };
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
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.get('/', (c) =>
  c.json({
    service: '@ff/layout-service',
    endpoints: [
      '/v1/auth',
      '/v1/me',
      '/v1/me/state',
      '/v1/events',
      '/v1/presence',
      '/v1/roles',
      '/v1/layouts',
      '/v1/validate',
    ],
  }),
);

// ---- Identity ----

/** How to sign in. In dev mode, the configured users (there's no password). */
app.get('/v1/auth', (c) =>
  c.json({
    mode: config.auth.mode,
    defaultUser: config.auth.defaultUser,
    users: Object.entries(config.auth.users).map(([id, u]) => ({
      id,
      name: u.name,
      role: u.role,
      roleLabel: config.roles[u.role].label,
    })),
  }),
);

/**
 * DEV ONLY: issue a token for a configured user, in a workspace. Stands in for
 * an identity provider's login; production would use OIDC instead.
 */
app.post('/v1/auth/dev-login', async (c) => {
  const {user, workspace = 'default'} = await c.req
    .json<{user?: string; workspace?: string}>()
    .catch(() => ({}) as {user?: string; workspace?: string});
  if (!user || !config.auth.users[user]) return c.json({error: 'Unknown user'}, 400);
  if (!isWorkspaceId(workspace)) return c.json({error: 'Invalid workspace id'}, 400);
  return c.json({token: await issueToken(config.auth, user, workspace)});
});

app.get('/v1/me', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  return c.json({
    user: {id: who.user, name: who.name},
    role: who.role,
    roleLabel: config.roles[who.role].label,
    canEdit: who.canEdit,
    workspace: who.workspace,
  });
});

// ---- Live updates ----

/**
 * Server-sent events for this workspace: `hello` (this connection's id),
 * `presence` (who is editing what), `layouts-changed` (refetch), and a `ping`
 * every 15s to keep proxies from closing the stream. Authenticated like every
 * other call — clients use a streaming fetch so the token stays in a header.
 */
app.get('/v1/events', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  return streamSSE(c, async (stream) => {
    const connId = hub.connect(who.workspace, who.user, who.name, (e) => {
      void stream.writeSSE({event: e.event, data: JSON.stringify(e.data)});
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      hub.disconnect(who.workspace, connId);
    });
    await stream.writeSSE({event: 'hello', data: JSON.stringify({connId})});
    await stream.writeSSE({event: 'presence', data: JSON.stringify(hub.presence(who.workspace))});
    while (open) {
      await stream.sleep(15_000);
      if (open) await stream.writeSSE({event: 'ping', data: '{}'});
    }
  });
});

/** Mark which view this connection is editing (or null), for presence. */
app.put('/v1/presence', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  const {connId, viewId} = await c.req.json<{connId: string; viewId: string | null}>();
  const ok = hub.setEditing(who.workspace, connId, who.user, viewId ?? null);
  return ok ? c.body(null, 204) : c.json({error: 'Unknown connection'}, 404);
});

const EMPTY_STATE: UserState = {liveByView: {}, blocks: {}};
const MAX_STATE_BYTES = 256 * 1024;

/** This user's ad-hoc changes in this workspace (private to them). */
app.get('/v1/me/state', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  const ws = await store.get(who.workspace);
  return c.json(ws.userState?.[who.user] ?? EMPTY_STATE);
});

app.put('/v1/me/state', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  const text = await c.req.text();
  if (text.length > MAX_STATE_BYTES) return c.json({error: 'State too large'}, 413);
  let state: UserState;
  try {
    state = JSON.parse(text) as UserState;
  } catch {
    return c.json({error: 'Invalid JSON'}, 400);
  }
  if (!state || typeof state.liveByView !== 'object' || typeof state.blocks !== 'object') {
    return c.json({error: 'Expected {liveByView, blocks}'}, 400);
  }
  const ws = await store.get(who.workspace);
  await store.put(who.workspace, {
    ...ws,
    userState: {...ws.userState, [who.user]: {liveByView: state.liveByView, blocks: state.blocks}},
  });
  return c.body(null, 204);
});

app.get('/v1/roles', (c) =>
  c.json({
    defaultRole: config.defaultRole,
    roles: Object.entries(config.roles).map(([id, r]) => ({id, label: r.label, canEdit: Boolean(r.canEdit)})),
  }),
);

app.get('/v1/layouts', async (c) => {
  const who = await caller(c);
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

interface SaveBody {
  view: LayoutView;
  /** Only the blocks this edit added or modified, each with its base `rev`. */
  changedBlocks?: Block[];
  /** Blocks this edit deleted, with the `rev` they had. */
  deletedBlocks?: {id: string; rev?: number}[];
}

interface Conflict {
  kind: 'view' | 'block';
  id: string;
  message: string;
}

/**
 * Optimistic concurrency: an edit carries the revision of every entity it
 * touches, and conflicts only if one of *those* changed since it was loaded —
 * two editors saving different views, or different blocks, don't collide.
 */
function conflictsFor(ws: Workspace, body: SaveBody): Conflict[] {
  const conflicts: Conflict[] = [];
  const view = ws.views.find((v) => v.id === body.view.id);
  // (A "new" view reusing an existing id has no rev, so it conflicts here too.)
  if (view && view.rev !== body.view.rev) {
    conflicts.push({kind: 'view', id: view.id, message: `View “${view.name}” was changed by someone else`});
  } else if (!view && body.view.rev !== undefined) {
    conflicts.push({kind: 'view', id: body.view.id, message: 'This view was deleted by someone else'});
  }
  for (const block of body.changedBlocks ?? []) {
    const current = ws.blocks[block.id];
    if (current ? current.rev !== block.rev : block.rev !== undefined) {
      conflicts.push({
        kind: 'block',
        id: block.id,
        message: current
          ? `Block “${current.label ?? block.id}” was changed by someone else`
          : `Block “${block.id}” was deleted by someone else`,
      });
    }
  }
  for (const deleted of body.deletedBlocks ?? []) {
    const current = ws.blocks[deleted.id];
    if (current && current.rev !== deleted.rev) {
      conflicts.push({kind: 'block', id: deleted.id, message: `Block “${current.label ?? deleted.id}” was changed by someone else`});
    }
  }
  return conflicts;
}

app.put('/v1/layouts/views/:id', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const body = await c.req.json<SaveBody>();
  const {view} = body;
  if (view?.id !== c.req.param('id')) return c.json({error: 'View id doesn’t match the URL'}, 400);

  const ws = await store.get(who.workspace);
  const conflicts = conflictsFor(ws, body);
  if (conflicts.length > 0) {
    return c.json(
      {error: 'Changed by someone else', conflicts, current: visibleTo(ws, who.role, who.canEdit)},
      409,
    );
  }

  // The registry after this edit, which is what the view is validated against.
  const blocks: BlockRegistry = {...ws.blocks};
  for (const {id} of body.deletedBlocks ?? []) delete blocks[id];
  for (const block of body.changedBlocks ?? []) {
    blocks[block.id] = {...block, rev: (ws.blocks[block.id]?.rev ?? 0) + 1};
  }
  let errors;
  try {
    errors = await validate(view, blocks);
  } catch (error) {
    return c.json({error: `Can’t reach the plugin registry to validate: ${error}`}, 503);
  }
  if (errors.length > 0) return c.json({error: 'Layout is invalid', errors}, 422);

  const current = ws.views.find((v) => v.id === view.id);
  const saved = {...view, rev: (current?.rev ?? 0) + 1};
  const next: Workspace = {
    ...ws,
    blocks,
    views: current ? ws.views.map((v) => (v.id === view.id ? saved : v)) : [...ws.views, saved],
  };
  await store.put(who.workspace, next);
  layoutsChanged(who.workspace, who, [view.id]);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

app.delete('/v1/layouts/views/:id', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const ws = await store.get(who.workspace);
  const target = ws.views.find((v) => v.id === c.req.param('id'));
  if (!target) return c.json({error: 'No such view'}, 404);
  const rev = c.req.query('rev');
  if (rev !== undefined && Number(rev) !== target.rev) {
    return c.json(
      {
        error: 'Changed by someone else',
        conflicts: [{kind: 'view', id: target.id, message: `View “${target.name}” was changed by someone else`}],
        current: visibleTo(ws, who.role, who.canEdit),
      },
      409,
    );
  }
  const views = ws.views.filter((v) => v.id !== target.id);
  if (views.length === 0) return c.json({error: 'Can’t delete the last view'}, 409);
  const next = {...ws, views};
  await store.put(who.workspace, next);
  layoutsChanged(who.workspace, who, [target.id]);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

app.post('/v1/layouts/reset', async (c) => {
  const who = await caller(c);
  if ('error' in who) return who.error;
  if (!who.canEdit) return c.json({error: `Role “${who.role}” can’t edit layouts`}, 403);
  const previous = await store.get(who.workspace);
  // Users' ad-hoc copies survive a reset; they're dropped client-side because
  // the views they were based on now have new revisions.
  const next = {...store.seed(previous), userState: previous.userState};
  await store.put(who.workspace, next);
  layoutsChanged(who.workspace, who, [...new Set([...previous.views, ...next.views].map((v) => v.id))]);
  return c.json(visibleTo(next, who.role, who.canEdit));
});

serve({fetch: app.fetch, port: PORT}, ({port}) => {
  console.log(`[layouts] listening on http://localhost:${port} (registry: ${config.registry})`);
});
