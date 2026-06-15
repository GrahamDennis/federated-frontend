import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {Hono} from 'hono';
import type {ContentCache} from './cache.ts';

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
 * The dumb, content-addressed half. `GET /content/<digest>/<path>` serves a file
 * from the unpacked bundle identified by `<digest>` (an OCI manifest digest).
 * It knows nothing about tags or discovery — only digests — so its responses are
 * immutable and cacheable forever.
 */
export function contentRouter(cache: ContentCache): Hono {
  const app = new Hono();

  app.get('/content/*', async (c) => {
    const rest = decodeURIComponent(c.req.path.slice(PREFIX.length));
    const slash = rest.indexOf('/');
    const digest = slash === -1 ? rest : rest.slice(0, slash);
    let filePath = slash === -1 ? '' : rest.slice(slash + 1);

    if (!digest.startsWith('sha256:')) {
      return c.text('content paths are addressed by sha256 digest', 400);
    }
    if (filePath === '' || filePath.endsWith('/')) filePath += 'index.html';

    let bundleDir: string;
    try {
      bundleDir = await cache.ensure(digest);
    } catch (err) {
      // Unknown digest, or a registry that is down / lacks the artifact.
      return c.text(`cannot serve ${digest}: ${(err as Error).message}`, 404);
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
