import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {Hono} from 'hono';
import type {ContentCache} from './cache.ts';
import type {Resolver} from './resolver.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const PREFIX = '/content/';

/**
 * The dumb, content-addressed half. `GET /content/<repo>@<digest>/<path>` serves
 * a file from the unpacked bundle identified by an OCI manifest `<digest>`. The
 * `<repo>` makes the URL self-documenting (which plugin) and self-locating: the
 * registry to pull from is looked up from config by repo (which is also the
 * safety allowlist — unconfigured repos are refused). It knows nothing about
 * tags, so its responses are immutable and cacheable forever.
 */
export function contentRouter(cache: ContentCache, resolver: Resolver): Hono {
  const app = new Hono();

  app.get('/content/*', async (c) => {
    const rest = decodeURIComponent(c.req.path.slice(PREFIX.length));
    // `<repo>@<digest>/<file>` — repo may contain slashes; split on the first `@`
    // (registries/repos never contain one), then the digest runs to the next `/`.
    const at = rest.indexOf('@');
    if (at === -1) {
      return c.text('content paths look like /content/<repo>@<digest>/<file>', 400);
    }
    const repository = rest.slice(0, at);
    const afterAt = rest.slice(at + 1);
    const slash = afterAt.indexOf('/');
    const digest = slash === -1 ? afterAt : afterAt.slice(0, slash);
    let filePath = slash === -1 ? '' : afterAt.slice(slash + 1);

    if (!digest.startsWith('sha256:')) {
      return c.text('content paths are addressed by sha256 digest', 400);
    }
    const registry = resolver.registryForRepo(repository);
    if (!registry) {
      return c.text(`repository not configured: ${repository}`, 404);
    }
    if (filePath === '' || filePath.endsWith('/')) filePath += 'index.html';

    let bundleDir: string;
    try {
      bundleDir = await cache.ensure(registry, repository, digest);
    } catch (err) {
      // Registry down, or the artifact/digest doesn't exist there.
      return c.text(`cannot serve ${repository}@${digest}: ${(err as Error).message}`, 404);
    }

    const abs = cache.resolveFile(bundleDir, filePath);
    if (!abs) return c.text('forbidden path', 403);

    let bytes: Uint8Array;
    try {
      bytes = await readFile(abs);
    } catch {
      return c.text('not found', 404);
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
        // Digest-addressed ⇒ immutable.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  return app;
}
