import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {loadConfig} from './config.ts';
import {Resolver} from './resolver.ts';
import {ContentCache} from './cache.ts';
import {contentRouter} from './content.ts';
import {discoveryRouter} from './discovery.ts';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.FF_REGISTRY_CONFIG ?? join(PKG_DIR, 'registry.config.yaml');
const PORT = Number(process.env.PORT ?? 5180);

const config = await loadConfig(CONFIG_PATH);
const resolver = new Resolver(config);
const cache = new ContentCache(resolver);

const app = new Hono();
app.get('/', (c) => c.json({service: '@ff/plugin-registry', endpoints: ['/v1/plugins', '/content/:digest/*']}));
// Preflight for the discovery API (host fetches it cross-origin).
app.options('/v1/*', (c) =>
  c.body(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }),
);
app.route('/', discoveryRouter(resolver, config));
app.route('/', contentRouter(cache));

// Warm tag resolution at startup so the digest->repo index is populated and the
// first content request isn't cold (best-effort; failures are logged).
resolver
  .resolveAll(true)
  .then((s) => console.log(`[registry] resolved ${s.length} plugin(s) from ${CONFIG_PATH}`))
  .catch((err) => console.error('[registry] initial resolve failed:', err));

serve({fetch: app.fetch, port: PORT}, ({port}) => {
  console.log(`[registry] listening on http://localhost:${port}`);
  console.log(`[registry]   discovery: http://localhost:${port}/v1/plugins`);
  console.log(`[registry]   content:   http://localhost:${port}/content/<digest>/`);
});
