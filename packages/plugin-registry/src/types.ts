/**
 * The plugin manifest: the metadata the host needs to decide whether and how to
 * load a plugin. Authored as `ff-plugin.json` at the bundle root (the single
 * source of truth), it travels with the artifact:
 *   - for OCI sources it is lifted into the artifact's *config blob*, so the
 *     registry can read it without pulling the (much larger) content layer;
 *   - for CDN sources it is fetched from `<url>/ff-plugin.json`.
 * Config-level `metadata` overrides are shallow-merged over whatever the source
 * reports.
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * `plugin` integrates with the chrome (thread + remote-dom); `external` is a
   * plain sandboxed iframe with no integration (e.g. an embedded website).
   */
  kind: 'plugin' | 'external';
  /** Entry document served at the content base URL. Defaults to `index.html`. */
  entry?: string;
  description?: string;
  /** Companion apps that can be docked as a subordinate detail panel. */
  detailApps?: string[];
  /** A detail-only companion: hidden from the main app rail. */
  detail?: boolean;
}

/**
 * Where a plugin's bytes live.
 *   - `oci`: an OCI artifact (resolved tag/digest → content-addressed serving).
 *   - `http`: an already-unpacked bundle at a URL — a CDN, an object store, or a
 *     Vite dev server. Metadata comes from `<url>/ff-plugin.json`; the URL is
 *     returned to the host unchanged (the content endpoint isn't involved).
 *   - `external`: an arbitrary website embedded as a non-integrated iframe. No
 *     bundle and no `ff-plugin.json`; metadata must be supplied via config
 *     `metadata` overrides.
 */
export type PluginSource =
  | {type: 'oci'; ref: string}
  | {type: 'http'; url: string}
  | {type: 'external'; url: string};

/** One entry in the config's `plugins` map. The map key is an opaque handle. */
export interface PluginEntry {
  source: PluginSource;
  /** Overrides shallow-merged over the manifest reported by the source. */
  metadata?: Partial<PluginManifest>;
}

export interface RegistryConfig {
  /**
   * Public base URL of THIS service, used to mint content URLs in discovery
   * responses (e.g. `http://localhost:5180`). If omitted, it is derived from the
   * incoming request — fine for local dev, set it explicitly behind a proxy.
   */
  contentBaseUrl?: string;
  /** Registries served over plain HTTP (no TLS). Defaults cover localhost. */
  insecureRegistries?: string[];
  /** Content-cache eviction tuning (configured plugins are always exempt). */
  cache?: {
    /** LRU size cap in MB for evictable bundles. */
    maxMB?: number;
    /** Evict an evictable bundle this many minutes after its last use. */
    ttlMinutes?: number;
    /** Eviction sweep interval in seconds. */
    sweepSeconds?: number;
  };
  plugins: Record<string, PluginEntry>;
}

/**
 * A plugin resolved to immutable coordinates, as returned by the discovery API.
 * `url` is always content-addressed: for OCI it points at this service's
 * `/content/<digest>/` (the moving tag never leaks); for CDN it is the
 * configured immutable URL.
 */
// `entry` is a resolution input (which document in the bundle to open), not part
// of the resolved view — it's folded into `entryUrl`, so it's omitted here.
export interface ResolvedPlugin extends Omit<PluginManifest, 'entry'> {
  /** Content base URL (always ends in `/`); reference other bundle files from it. */
  url: string;
  /** The app's entry document URL — what the host loads. */
  entryUrl: string;
  /** Manifest digest for OCI sources; absent for CDN. */
  digest?: string;
  /** The opaque config key this plugin was declared under. */
  key: string;
}
