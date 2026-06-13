import type {RemoteConnection} from '@remote-dom/core/elements';

/**
 * Origins the host and plugins are served from in this prototype. They are
 * deliberately *different* origins so the iframe boundary provides real
 * isolation (separate JS realms, separate cookie jars, enforced by the browser).
 */
export const HOST_ORIGIN = 'http://localhost:5173';
export const PLUGIN_ORIGIN = 'http://localhost:5174';

export type ToastTone = 'info' | 'success' | 'critical';

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Defaults to 4000. */
  durationMs?: number;
}

/**
 * A command a plugin contributes to the host's command palette (Cmd-K).
 *
 * `run` is defined inside the plugin (a different realm/origin); `@quilted/threads`
 * proxies it across the boundary so the host can invoke it when the user selects
 * the command. The host must keep the descriptor referenced for the proxy to stay
 * alive.
 */
export interface CommandDescriptor {
  id: string;
  title: string;
  subtitle?: string;
  run(): void | Promise<void>;
}

/**
 * The capability API the host exposes *to* each plugin. This is the
 * imperative / data-only channel: the plugin asks the host to do something and
 * the host renders its own native UI. Use this for transient or callback-driven
 * surfaces (toasts, command registration) where shipping a DOM tree would be
 * awkward.
 *
 * Methods return promises because `@quilted/threads` turns every cross-boundary
 * call asynchronous (and its `ThreadImports` type drops non-promise methods).
 */
export interface HostApi {
  toast(message: string, options?: ToastOptions): Promise<void>;
  /** Replace this plugin's contributed command-palette entries. */
  setCommands(commands: CommandDescriptor[]): Promise<void>;
  /**
   * Other apps available in the surrounding shell (excluding the caller), so a
   * plugin can offer to switch to a sibling app. This capability is inherently
   * host-only — there is no equivalent when the app runs standalone.
   */
  listApps(): Promise<AppSummary[]>;
  /** Ask the shell to bring another app to the foreground. Host-only. */
  activateApp(appId: string): Promise<void>;
}

/** A sibling app surfaced to a plugin by {@link HostApi.listApps}. */
export interface AppSummary {
  id: string;
  name: string;
}

/**
 * The full surface the host exports over the thread: the public capability API
 * plus an internal `connect()` the plugin calls to obtain the host's remote-dom
 * {@link RemoteConnection}. The plugin attaches its contributed component tree
 * (toolbar section, modal, …) to that connection — the declarative /
 * component-contribution channel.
 *
 * The *plugin* pulls the connection (rather than the host pushing it) so that
 * the first cross-boundary message originates from the side that loads last,
 * avoiding a postMessage race against an unattached listener.
 */
export interface HostThread extends HostApi {
  connect(): Promise<RemoteConnection>;
}
