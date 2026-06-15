import {gunzipSync} from 'node:zlib';
import {mkdir, readdir, rename, rm, stat, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, normalize, sep} from 'node:path';
import {parseTar} from 'nanotar';
import {type OciClient, PLUGIN_CONTENT_MEDIA_TYPE} from './oci/client.ts';

const ROOT = process.env.FF_CONTENT_CACHE ?? join(tmpdir(), 'ff-plugin-content');

/** Eviction policy. Configured plugins (their resolved digests) are exempt. */
export interface CacheOptions {
  /** LRU size cap (bytes) for evictable bundles. */
  maxBytes: number;
  /** Evict an evictable bundle this long after its last use (ms). */
  ttlMs: number;
  /** How often the eviction sweep runs (ms). */
  sweepIntervalMs: number;
  /** Digests that must never be evicted (the currently-configured plugins). */
  pinned: () => Promise<Set<string>>;
}

interface Entry {
  dir: string;
  size: number;
  lastAccess: number;
}

/**
 * A content-addressed, on-disk cache of unpacked plugin bundles, keyed by OCI
 * manifest digest. The content is immutable, so an extracted bundle is reused as
 * long as it's present. The registry + repository to pull from are supplied by
 * the caller (read out of the request URL).
 *
 * Eviction: the digests of currently-configured plugins are pinned and never
 * removed. Everything else (old versions, de-configured plugins) is evicted
 * either {@link CacheOptions.ttlMs} after its last use, or — when the cache
 * exceeds {@link CacheOptions.maxBytes} — least-recently-used first.
 */
export class ContentCache {
  /** digest -> extraction promise, to coalesce concurrent first-requests. */
  private readonly inflight = new Map<string, Promise<string>>();
  /** digest -> bundle metadata, for access tracking + eviction. */
  private readonly entries = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly client: OciClient,
    private readonly opts: CacheOptions,
  ) {}

  /** Register bundles already on disk (across restarts) and start the sweep. */
  async start(): Promise<void> {
    for (const dirent of await readdir(ROOT, {withFileTypes: true}).catch(() => [])) {
      if (!dirent.isDirectory()) continue;
      const dir = join(ROOT, dirent.name);
      if (!(await exists(join(dir, '.extracted')))) continue;
      const digest = dirent.name.replace('_', ':'); // sha256_<hex> -> sha256:<hex>
      const marker = await stat(join(dir, '.extracted')).catch(() => undefined);
      this.entries.set(digest, {
        dir,
        size: await dirSize(dir),
        lastAccess: marker?.mtimeMs ?? Date.now(),
      });
    }
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
    this.sweepTimer.unref?.(); // don't keep the process alive for the timer
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Ensure a digest is extracted; returns the absolute bundle directory. */
  async ensure(registry: string, repository: string, digest: string): Promise<string> {
    const entry = this.entries.get(digest);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.dir;
    }

    let pending = this.inflight.get(digest);
    if (!pending) {
      pending = this.extract(registry, repository, digest).finally(() =>
        this.inflight.delete(digest),
      );
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

  private async extract(registry: string, repository: string, digest: string): Promise<string> {
    const dir = join(ROOT, digest.replace(/[:/]/g, '_'));
    const {manifest} = await this.client.getManifest(registry, repository, digest);
    const layer =
      manifest.layers.find((l) => l.mediaType === PLUGIN_CONTENT_MEDIA_TYPE) ?? manifest.layers[0];
    if (!layer) throw new Error(`artifact ${digest} has no content layer`);

    const gz = await this.client.getBlob(registry, repository, layer.digest);
    const files = parseTar(gunzipSync(gz));

    // Extract into a temp dir, then atomically swap into place.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await rm(tmp, {recursive: true, force: true});
    let size = 0;
    for (const file of files) {
      if (!file.name || file.name.endsWith('/')) continue; // skip directories
      const rel = file.name.replace(/^\.?\//, '');
      const dest = join(tmp, rel);
      await mkdir(dirname(dest), {recursive: true});
      const data = file.data ?? new Uint8Array();
      await writeFile(dest, data);
      size += data.byteLength;
    }
    await writeFile(join(tmp, '.extracted'), '');
    await rm(dir, {recursive: true, force: true});
    await mkdir(dirname(dir), {recursive: true});
    await rename(tmp, dir);

    this.entries.set(digest, {dir, size, lastAccess: Date.now()});
    void this.enforceSize(); // a burst of new bundles shouldn't wait for the sweep
    return dir;
  }

  /** Periodic eviction: TTL-since-last-use, then the size cap. Pinned exempt. */
  private async sweep(): Promise<void> {
    let pinned: Set<string>;
    try {
      pinned = await this.opts.pinned();
    } catch {
      return; // can't determine what's configured — skip rather than risk evicting it
    }
    const cutoff = Date.now() - this.opts.ttlMs;
    for (const [digest, entry] of this.entries) {
      if (this.evictable(digest, pinned) && entry.lastAccess < cutoff) {
        await this.evict(digest, 'idle');
      }
    }
    await this.enforceSize(pinned);
  }

  /** Evict least-recently-used evictable bundles until under the size cap. */
  private async enforceSize(pinned?: Set<string>): Promise<void> {
    const pins = pinned ?? (await this.opts.pinned().catch(() => new Set<string>()));
    let total = 0;
    for (const e of this.entries.values()) total += e.size;
    if (total <= this.opts.maxBytes) return;

    const lru = [...this.entries.entries()]
      .filter(([digest]) => this.evictable(digest, pins))
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [digest, entry] of lru) {
      if (total <= this.opts.maxBytes) break;
      await this.evict(digest, 'size');
      total -= entry.size;
    }
  }

  private evictable(digest: string, pinned: Set<string>): boolean {
    return !pinned.has(digest) && !this.inflight.has(digest);
  }

  private async evict(digest: string, reason: 'idle' | 'size'): Promise<void> {
    const entry = this.entries.get(digest);
    if (!entry) return;
    this.entries.delete(digest);
    await rm(entry.dir, {recursive: true, force: true});
    console.log(`[cache] evicted ${digest} (${reason}, ${(entry.size / 1e6).toFixed(1)}MB)`);
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const dirent of await readdir(dir, {recursive: true, withFileTypes: true})) {
    if (dirent.isFile()) {
      const s = await stat(join(dirent.parentPath, dirent.name)).catch(() => undefined);
      total += s?.size ?? 0;
    }
  }
  return total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
