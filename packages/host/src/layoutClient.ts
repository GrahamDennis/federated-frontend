/// <reference types="vite/client" />
import type {Block, BlockRegistry, LayoutView, ValidationError} from '@ff/layout-model';

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

/** The token was missing, expired or rejected: sign in again. */
export class AuthExpired extends Error {}

/** A user one can sign in as (dev mode lists them; there's no password). */
export interface DevUser {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
}

/** Who the current token says we are. */
export interface Me {
  user: {id: string; name: string};
  role: string;
  roleLabel: string;
  canEdit: boolean;
  workspace: string;
}

/** A user's private ad-hoc changes (see the service's UserState). */
export interface UserState {
  liveByView: Record<string, LayoutView>;
  blocks: BlockRegistry;
}

/** One entity another editor changed since this edit began. */
export interface Conflict {
  kind: 'view' | 'block';
  id: string;
  message: string;
}

/**
 * The save lost a race: something it touched was changed by someone else
 * since it was loaded. `current` is the service's latest state.
 */
export class LayoutConflict extends Error {
  constructor(
    message: string,
    readonly conflicts: Conflict[],
    readonly current: ServedLayouts,
  ) {
    super(message);
  }
}

/**
 * Client for `@ff/layout-service`, acting as the user a signed token names.
 * The service derives user, role and workspace from the token alone.
 */
export class LayoutClient {
  constructor(readonly token: string) {}

  /** How to sign in (dev mode: the users one can pick). */
  static async auth(): Promise<{mode: 'dev'; defaultUser: string; users: DevUser[]}> {
    const res = await fetch(`${SERVICE_URL}/v1/auth`);
    if (!res.ok) throw new Error(`layout service ${res.status}`);
    return res.json();
  }

  /** DEV ONLY: get a token for a configured user (stands in for an IdP login). */
  static async devLogin(user: string, workspace: string): Promise<string> {
    const res = await fetch(`${SERVICE_URL}/v1/auth/dev-login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({user, workspace}),
    });
    if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
    return (await res.json()).token;
  }

  static async roles(): Promise<{defaultRole: string; roles: Role[]}> {
    const res = await fetch(`${SERVICE_URL}/v1/roles`);
    if (!res.ok) throw new Error(`layout service ${res.status}`);
    return res.json();
  }

  me(): Promise<Me> {
    return this.call('GET', '/v1/me') as Promise<unknown> as Promise<Me>;
  }

  getState(): Promise<UserState> {
    return this.call('GET', '/v1/me/state') as Promise<unknown> as Promise<UserState>;
  }

  async putState(state: UserState): Promise<void> {
    await this.call('PUT', '/v1/me/state', state);
  }

  /** Say which view this live connection is editing (null = none). */
  async setPresence(connId: string, viewId: string | null): Promise<void> {
    await this.call('PUT', '/v1/presence', {connId, viewId});
  }

  load(): Promise<ServedLayouts> {
    return this.call('GET', '/v1/layouts');
  }

  /**
   * Save a view plus only the blocks this edit changed or deleted. Each
   * carries the `rev` it was based on, so the service can detect lost updates.
   */
  saveView(
    view: LayoutView,
    changedBlocks: Block[],
    deletedBlocks: {id: string; rev?: number}[],
  ): Promise<ServedLayouts> {
    return this.call('PUT', `/v1/layouts/views/${encodeURIComponent(view.id)}`, {
      view,
      changedBlocks,
      deletedBlocks,
    });
  }

  deleteView(id: string, rev?: number): Promise<ServedLayouts> {
    const query = rev === undefined ? '' : `?rev=${rev}`;
    return this.call('DELETE', `/v1/layouts/views/${encodeURIComponent(id)}${query}`);
  }

  reset(): Promise<ServedLayouts> {
    return this.call('POST', '/v1/layouts/reset');
  }

  private async call(method: string, path: string, body?: unknown): Promise<ServedLayouts> {
    const res = await fetch(`${SERVICE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json as ServedLayouts;
    if (res.status === 401) throw new AuthExpired(json.error ?? 'Sign in required');
    if (res.status === 409 && json.current) {
      throw new LayoutConflict(json.error, json.conflicts ?? [], json.current as ServedLayouts);
    }
    throw new LayoutRejected(json.error ?? `layout service ${res.status}`, json.errors ?? []);
  }
}
