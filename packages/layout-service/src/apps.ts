import type {AppPorts} from '@ff/layout-model';

const TTL_MS = 30_000;

/**
 * The apps (plugins) that exist, with their typed ports, from the plugin
 * registry's discovery API. Cached briefly; validation needs it on every save.
 */
export class AppCatalog {
  private cached: {at: number; apps: AppPorts[]} | null = null;

  constructor(private readonly registryUrl: string) {}

  async apps(): Promise<AppPorts[]> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.apps;
    const res = await fetch(`${this.registryUrl}/v1/plugins`);
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const {plugins} = (await res.json()) as {plugins: AppPorts[]};
    const apps = plugins.map(({id, inputs, outputs}) => ({id, inputs, outputs}));
    this.cached = {at: Date.now(), apps};
    return apps;
  }
}
