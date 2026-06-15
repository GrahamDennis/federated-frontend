/// <reference types="vite/client" />

/**
 * An app the chrome can host. `plugin` apps integrate with the chrome over the
 * capability + remote-dom channels; `external` apps are just sandboxed iframes
 * with no integration at all.
 *
 * The chrome no longer hardcodes any individual app: this descriptor is built
 * from the plugin-registry discovery API at boot (see {@link fetchApps}). The
 * host's only configuration is where the registry lives.
 */
export interface AppDescriptor {
  id: string;
  name: string;
  kind: 'plugin' | 'external';
  /** Full URL of the app's entry document (its origin is the iframe origin). */
  src: string;
  description?: string;
  /** Companion apps that can be docked as a subordinate detail panel. */
  detailApps?: string[];
  /** Marks an app as a detail-only companion: hidden from the main rail. */
  detail?: boolean;
}

/** The discovery API's view of a plugin (the fields the chrome consumes). */
interface DiscoveredPlugin {
  id: string;
  name: string;
  kind: 'plugin' | 'external';
  entryUrl: string;
  description?: string;
  detailApps?: string[];
  detail?: boolean;
}

const REGISTRY_URL =
  import.meta.env.VITE_PLUGIN_REGISTRY_URL ?? 'http://localhost:5180';

/**
 * Fetch the available apps from the plugin-registry discovery API. The host
 * names no specific plugin — the registry is the single source of truth; the
 * host could pass `?kind=` (or other) filters here for the plugins it can host.
 */
export async function fetchApps(): Promise<AppDescriptor[]> {
  const res = await fetch(`${REGISTRY_URL}/v1/plugins`);
  if (!res.ok) throw new Error(`discovery ${REGISTRY_URL}/v1/plugins -> ${res.status}`);
  const {plugins} = (await res.json()) as {plugins: DiscoveredPlugin[]};
  return plugins.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    src: p.entryUrl,
    description: p.description,
    detailApps: p.detailApps,
    detail: p.detail,
  }));
}
