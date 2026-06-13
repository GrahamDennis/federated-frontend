import type {RemoteConnection} from '@remote-dom/core/elements';

/**
 * Origins the host and plugins are served from in this prototype. They are
 * deliberately *different* origins so the iframe boundary provides real
 * isolation (separate JS realms, separate cookie jars, enforced by the browser).
 */
export const HOST_ORIGIN = 'http://localhost:5173';
export const PLUGIN_ORIGIN = 'http://localhost:5174';
export const MAP_PLUGIN_ORIGIN = 'http://localhost:5175';
export const PLACES_PLUGIN_ORIGIN = 'http://localhost:5176';

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

  /**
   * Forward a keyboard shortcut that fired inside the plugin's iframe to the
   * host, so global shortcuts (⌘K, Escape, …) work even when the iframe has
   * focus. A cross-origin iframe is a hard boundary — the host can't see these
   * keystrokes itself, so cooperating plugins relay them (see
   * {@link forwardKeyboardShortcuts}).
   */
  forwardKeydown(event: ForwardedKeyEvent): Promise<void>;

  /**
   * Shared workspace context, host-mediated. This is how multiple apps composed
   * into one workspace cohere around the same data (e.g. a "current selection").
   * The host is the domain-agnostic broker: it stores a bag and broadcasts
   * changes; the apps agree on its shape (see {@link SharedContext}).
   */
  getContext(): Promise<SharedContext>;
  /** Shallow-merge a patch into the shared context and notify subscribers. */
  setContext(patch: SharedContext): Promise<void>;
  /**
   * Subscribe to shared-context changes. Returns an unsubscribe function. The
   * listener is also dropped automatically when this app's thread closes.
   */
  subscribeContext(
    listener: (context: SharedContext) => void,
  ): Promise<() => void>;
}

/**
 * The shared-context shape these example apps agree on. The host treats it
 * opaquely; only the apps interpret it. `selectedPlace` is the "current
 * selection" the map (hub) publishes and the Places panel (detail) reflects.
 */
export interface SharedContext {
  selectedPlace?: SelectedPlace | null;
}

export interface SelectedPlace {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  zoom?: number;
}

/** A sibling app surfaced to a plugin by {@link HostApi.listApps}. */
export interface AppSummary {
  id: string;
  name: string;
}

/** The serializable subset of a `KeyboardEvent` relayed from a plugin to the host. */
export interface ForwardedKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Relay global keyboard shortcuts from a plugin's iframe to the host. Attach once
 * after connecting; returns a cleanup function.
 *
 * Only chord shortcuts (with ⌘/Ctrl) and Escape are forwarded — never ordinary
 * typing — so the host can drive global shortcuts without being able to observe
 * what the user types into the plugin. Nothing is `preventDefault`ed, so the
 * plugin's own ⌘C/⌘V etc. keep working.
 */
export function forwardKeyboardShortcuts(host: {
  forwardKeydown(event: ForwardedKeyEvent): unknown;
}): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const isChord = event.metaKey || event.ctrlKey;
    if (!isChord && event.key !== 'Escape') return;
    host.forwardKeydown({
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
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
