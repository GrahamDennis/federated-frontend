import type {PluginEntry, PluginManifest, RegistryConfig} from './types.ts';
import {OciClient, parseRef} from './oci/client.ts';

/** A config entry resolved to immutable coordinates + its plugin manifest. */
export type ResolvedSource =
  | {kind: 'oci'; key: string; manifest: PluginManifest; digest: string}
  // `url` ends with `/`; the content base. Entry is appended for the entry URL.
  | {kind: 'http'; key: string; manifest: PluginManifest; url: string}
  // `url` is used verbatim as both content and entry URL (no bundle).
  | {kind: 'external'; key: string; manifest: PluginManifest; url: string};

/** Where to pull an OCI manifest digest from. */
interface RepoLocation {
  registry: string;
  repository: string;
}

const TTL_MS = 30_000;

function normaliseManifest(raw: Partial<PluginManifest>, key: string): PluginManifest {
  if (!raw.id) throw new Error(`plugin \`${key}\`: manifest has no \`id\``);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    version: raw.version ?? '0.0.0',
    kind: raw.kind ?? 'plugin',
    entry: raw.entry ?? 'index.html',
    description: raw.description,
    detailApps: raw.detailApps,
    detail: raw.detail,
  };
}

/**
 * Resolves configured sources to immutable manifests, and (for OCI) records a
 * `manifest-digest -> repo` index so the content endpoint can pull a bare
 * digest. Tag resolution is cached for {@link TTL_MS}; pass `force` to refresh.
 */
export class Resolver {
  private readonly oci: OciClient;
  private readonly locations = new Map<string, RepoLocation>();
  private cache: {at: number; sources: ResolvedSource[]} | undefined;
  private inflight: Promise<{sources: ResolvedSource[]; allOk: boolean}> | undefined;

  constructor(private readonly config: RegistryConfig) {
    this.oci = new OciClient(config.insecureRegistries ?? []);
  }

  /** The OCI client, shared with the content cache for blob pulls. */
  get client(): OciClient {
    return this.oci;
  }

  async resolveAll(force = false): Promise<ResolvedSource[]> {
    if (!force && this.cache && Date.now() - this.cache.at < TTL_MS) {
      return this.cache.sources;
    }
    // Coalesce concurrent refreshes.
    if (!this.inflight) {
      this.inflight = this.doResolveAll().finally(() => {
        this.inflight = undefined;
      });
    }
    const {sources, allOk} = await this.inflight;
    // Only cache a fully-successful resolve, so a transient failure (e.g. a Vite
    // dev server not up yet) self-heals on the next request instead of being
    // pinned as missing for the whole TTL.
    if (allOk) this.cache = {at: Date.now(), sources};
    return sources;
  }

  /** Look up where to pull an OCI manifest digest, refreshing once on a miss. */
  async locate(digest: string): Promise<RepoLocation | undefined> {
    if (this.locations.has(digest)) return this.locations.get(digest);
    await this.resolveAll(true);
    return this.locations.get(digest);
  }

  private async doResolveAll(): Promise<{sources: ResolvedSource[]; allOk: boolean}> {
    const entries = Object.entries(this.config.plugins);
    const settled = await Promise.allSettled(
      entries.map(([key, entry]) => this.resolveOne(key, entry)),
    );
    const sources: ResolvedSource[] = [];
    let allOk = true;
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        sources.push(result.value);
      } else {
        allOk = false;
        console.error(`[resolver] plugin \`${entries[i][0]}\` failed:`, result.reason?.message ?? result.reason);
      }
    });
    return {sources, allOk};
  }

  private async resolveOne(key: string, entry: PluginEntry): Promise<ResolvedSource> {
    const overrides = entry.metadata ?? {};
    const src = entry.source;

    if (src.type === 'oci') {
      const {registry, repository, reference} = parseRef(src.ref);
      const {digest, manifest} = await this.oci.getManifest(registry, repository, reference);
      this.locations.set(digest, {registry, repository});

      const configBytes = await this.oci.getBlob(registry, repository, manifest.config.digest);
      const fromSource = JSON.parse(new TextDecoder().decode(configBytes)) as Partial<PluginManifest>;
      return {kind: 'oci', key, digest, manifest: normaliseManifest({...fromSource, ...overrides}, key)};
    }

    if (src.type === 'external') {
      // No bundle to read; metadata is entirely from config overrides.
      return {kind: 'external', key, url: src.url, manifest: normaliseManifest(overrides, key)};
    }

    // http: an unpacked bundle (CDN / object store / Vite dev server). Metadata
    // comes from <url>/ff-plugin.json.
    const base = src.url.endsWith('/') ? src.url : src.url + '/';
    const res = await fetch(new URL('ff-plugin.json', base));
    if (!res.ok) throw new Error(`http ${base}ff-plugin.json -> ${res.status}`);
    const fromSource = (await res.json()) as Partial<PluginManifest>;
    return {kind: 'http', key, url: base, manifest: normaliseManifest({...fromSource, ...overrides}, key)};
  }
}
