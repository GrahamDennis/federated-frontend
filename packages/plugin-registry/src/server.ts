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
const cache = new ContentCache(resolver.client, {
  maxBytes: (config.cache?.maxMB ?? 512) * 1024 * 1024,
  ttlMs: (config.cache?.ttlMinutes ?? 60) * 60_000,
  sweepIntervalMs: (config.cache?.sweepSeconds ?? 60) * 1000,
  // Pin the currently-configured plugins' resolved digests so they're never evicted.
  pinned: async () => {
    const sources = await resolver.resolveAll();
    return new Set(sources.flatMap((s) => (s.kind === 'oci' ? [s.digest] : [])));
  },
});
await cache.start();

const app = new Hono();
app.get('/', (c) => c.json({service: '@ff/plugin-registry', endpoints: ['/v1/plugins', '/content/<repo>@<digest>/*']}));
// Preflight for the discovery API (host fetches it cross-origin).
app.options('/v1/*', (c) =>
  c.body(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }),
);
app.route('/', discoveryRouter(resolver, config));
app.route('/', contentRouter(cache, resolver));

// Warm tag resolution at startup so /v1/plugins is ready immediately (best-effort).
resolver
  .resolveAll(true)
  .then((s) => console.log(`[registry] resolved ${s.length} plugin(s) from ${CONFIG_PATH}`))
  .catch((err) => console.error('[registry] initial resolve failed:', err));

serve({fetch: app.fetch, port: PORT}, ({port}) => {
  console.log(`[registry] listening on http://localhost:${port}`);
  console.log(`[registry]   discovery: http://localhost:${port}/v1/plugins`);
  console.log(`[registry]   content:   http://localhost:${port}/content/<repo>@<digest>/`);
});
