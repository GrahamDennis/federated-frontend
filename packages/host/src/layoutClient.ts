/// <reference types="vite/client" />
import type {BlockRegistry, LayoutView, ValidationError} from '@ff/layout-model';

const SERVICE_URL = import.meta.env.VITE_LAYOUT_SERVICE_URL ?? 'http://localhost:5181';

export interface Role {
  id: string;
  label: string;
  canEdit: boolean;
}

/** What the layout service returns for one role in one workspace. */
export interface ServedLayouts {
  role: string;
  canEdit: boolean;
  views: LayoutView[];
  blocks: BlockRegistry;
}

/** The service rejected a save; `errors` says why (from `validateLayout`). */
export class LayoutRejected extends Error {
  constructor(
    message: string,
    readonly errors: ValidationError[],
  ) {
    super(message);
  }
}

/**
 * Client for `@ff/layout-service`. Role and workspace travel as headers — a
 * PROTOTYPE stand-in for an authenticated session.
 */
export class LayoutClient {
  constructor(
    readonly role: string,
    readonly workspace: string,
  ) {}

  static async roles(): Promise<{defaultRole: string; roles: Role[]}> {
    const res = await fetch(`${SERVICE_URL}/v1/roles`);
    if (!res.ok) throw new Error(`layout service ${res.status}`);
    return res.json();
  }

  load(): Promise<ServedLayouts> {
    return this.call('GET', '/v1/layouts');
  }

  saveView(view: LayoutView, blocks: BlockRegistry): Promise<ServedLayouts> {
    return this.call('PUT', `/v1/layouts/views/${encodeURIComponent(view.id)}`, {view, blocks});
  }

  deleteView(id: string): Promise<ServedLayouts> {
    return this.call('DELETE', `/v1/layouts/views/${encodeURIComponent(id)}`);
  }

  reset(): Promise<ServedLayouts> {
    return this.call('POST', '/v1/layouts/reset');
  }

  private async call(method: string, path: string, body?: unknown): Promise<ServedLayouts> {
    const res = await fetch(`${SERVICE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-FF-Role': this.role,
        'X-FF-Workspace': this.workspace,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json as ServedLayouts;
    throw new LayoutRejected(json.error ?? `layout service ${res.status}`, json.errors ?? []);
  }
}
