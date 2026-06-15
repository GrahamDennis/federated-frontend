import {gunzipSync} from 'node:zlib';
import {mkdir, rename, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, normalize, sep} from 'node:path';
import {parseTar} from 'nanotar';
import {PLUGIN_CONTENT_MEDIA_TYPE} from './oci/client.ts';
import type {Resolver} from './resolver.ts';

const ROOT = process.env.FF_CONTENT_CACHE ?? join(tmpdir(), 'ff-plugin-content');

/**
 * A content-addressed, on-disk cache of unpacked plugin bundles, keyed by OCI
 * manifest digest. Because the key is a digest the content is immutable, so an
 * extracted bundle is reused forever once present.
 */
export class ContentCache {
  /** digest -> extraction promise, to coalesce concurrent first-requests. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly resolver: Resolver) {}

  /** Ensure a digest is extracted; returns the absolute bundle directory. */
  async ensure(digest: string): Promise<string> {
    const dir = join(ROOT, digest.replace(/[:/]/g, '_'));
    if (await exists(join(dir, '.extracted'))) return dir;

    let pending = this.inflight.get(digest);
    if (!pending) {
      pending = this.extract(digest, dir).finally(() => this.inflight.delete(digest));
      this.inflight.set(digest, pending);
    }
    return pending;
  }

  /**
   * Resolve a request path to an absolute file path inside the bundle, or
   * undefined if it escapes the bundle (path traversal).
   */
  resolveFile(bundleDir: string, requestPath: string): string | undefined {
    const clean = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const abs = join(bundleDir, clean);
    if (abs !== bundleDir && !abs.startsWith(bundleDir + sep)) return undefined;
    return abs;
  }

  private async extract(digest: string, dir: string): Promise<string> {
    const loc = await this.resolver.locate(digest);
    if (!loc) throw new Error(`unknown digest (not from a configured source): ${digest}`);

    const {manifest} = await this.resolver.client.getManifest(loc.registry, loc.repository, digest);
    const layer =
      manifest.layers.find((l) => l.mediaType === PLUGIN_CONTENT_MEDIA_TYPE) ?? manifest.layers[0];
    if (!layer) throw new Error(`artifact ${digest} has no content layer`);

    const gz = await this.resolver.client.getBlob(loc.registry, loc.repository, layer.digest);
    const files = parseTar(gunzipSync(gz));

    // Extract into a temp dir, then atomically swap into place.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await rm(tmp, {recursive: true, force: true});
    for (const file of files) {
      if (!file.name || file.name.endsWith('/')) continue; // skip directories
      const rel = file.name.replace(/^\.?\//, '');
      const dest = join(tmp, rel);
      await mkdir(dirname(dest), {recursive: true});
      await writeFile(dest, file.data ?? new Uint8Array());
    }
    await writeFile(join(tmp, '.extracted'), '');
    await rm(dir, {recursive: true, force: true});
    await mkdir(dirname(dir), {recursive: true});
    await rename(tmp, dir);
    return dir;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
