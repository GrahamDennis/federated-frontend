import {ThreadWindow, type ThreadImports} from '@quilted/threads';
import {HOST_ORIGIN, type HostThread} from '@ff/protocol';
import type {RemoteConnection} from '@remote-dom/core/elements';

/** The host's capability API, as async proxies over the thread. */
export type Host = ThreadImports<HostThread>;

export interface HostConnection {
  host: Host;
  /**
   * The host's remote-dom connection — stream contributed UI to it (e.g. via
   * {@link RemoteContributions}). Plugins that don't contribute remote-dom can
   * ignore it.
   */
  connection: RemoteConnection;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('host handshake timed out')),
      ms,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Establish a connection to the host shell, if the plugin is embedded in one.
 *
 * Top-level => not hosted (`null`). Framed => attempt the handshake (which also
 * yields the remote-dom connection) and fall back to `null` if no host answers
 * in time — so the plugin also survives being embedded by an unrelated page.
 *
 * The imports proxy is returned *wrapped* in an object, never bare from this
 * async function: a `@quilted/threads` imports proxy has no `then` guard, so
 * `Promise.resolve` would thenable-check it and fire a phantom remote `then()`
 * call.
 */
export async function connectToHost(
  {timeoutMs = 2500}: {timeoutMs?: number} = {},
): Promise<HostConnection | null> {
  const framed = (() => {
    try {
      return window.top !== window.self;
    } catch {
      // Cross-origin parent: we're definitely framed.
      return true;
    }
  })();
  if (!framed) return null;

  const thread = ThreadWindow.parent<HostThread>({targetOrigin: HOST_ORIGIN});
  try {
    const connection = await withTimeout(thread.imports.connect(), timeoutMs);
    return {host: thread.imports, connection};
  } catch {
    thread.close();
    return null;
  }
}
