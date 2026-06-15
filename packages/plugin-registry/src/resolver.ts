import type {PluginEntry, PluginManifest, RegistryConfig} from './types.ts';
import {OciClient, parseRef} from './oci/client.ts';

/** A config entry resolved to immutable coordinates + its plugin manifest. */
export type ResolvedSource =
  // The OCI coordinate (registry + repository + digest) is carried through so the
  // discovery URL can be the full, self-locating artifact reference.
  | {kind: 'oci'; key: string; manifest: PluginManifest; registry: string; repository: string; digest: string}
  // `url` ends with `/`; the content base. Entry is appended for the entry URL.
  | {kind: 'http'; key: string; manifest: PluginManifest; url: string}
  // `url` is used verbatim as both content and entry URL (no bundle).
  | {kind: 'external'; key: string; manifest: PluginManifest; url: string};

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
 * Resolves configured sources to immutable manifests. Tag resolution is cached
 * for {@link TTL_MS}; pass `force` to refresh. The content endpoint reads the
 * repo to pull from straight out of the request URL (`/content/<repo>@<digest>/`),
 * so the resolver keeps no digest→repo index — it only maps a configured repo to
 * its registry host ({@link registryForRepo}), which doubles as the content
 * endpoint's safety allowlist (unconfigured repos resolve to undefined).
 */
export class Resolver {
  private readonly oci: OciClient;
  /** repository -> registry host, for every configured OCI source. */
  private readonly repoRegistry = new Map<string, string>();
  private cache: {at: number; sources: ResolvedSource[]} | undefined;
  private inflight: Promise<{sources: ResolvedSource[]; allOk: boolean}> | undefined;

  constructor(private readonly config: RegistryConfig) {
    this.oci = new OciClient(config.insecureRegistries ?? []);
    for (const entry of Object.values(config.plugins)) {
      if (entry.source.type === 'oci') {
        const {registry, repository} = parseRef(entry.source.ref);
        this.repoRegistry.set(repository, registry);
      }
    }
  }

  /** The OCI client, shared with the content cache for blob pulls. */
  get client(): OciClient {
    return this.oci;
  }

  /** The registry host for a configured repository, or undefined (= not allowed). */
  registryForRepo(repository: string): string | undefined {
    return this.repoRegistry.get(repository);
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

      const configBytes = await this.oci.getBlob(registry, repository, manifest.config.digest);
      const fromSource = JSON.parse(new TextDecoder().decode(configBytes)) as Partial<PluginManifest>;
      return {
        kind: 'oci',
        key,
        registry,
        repository,
        digest,
        manifest: normaliseManifest({...fromSource, ...overrides}, key),
      };
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
