import {createRoot} from 'react-dom/client';
import {ThreadWindow} from '@quilted/threads';
import type {ThreadImports} from '@quilted/threads';
import {HOST_ORIGIN, type HostThread} from '@ff/protocol';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MapApp} from './MapApp';
import './styles.css';

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
 * Connect to a host if we're embedded in one (and it answers the handshake);
 * otherwise run standalone. `listApps` doubles as a cheap "are you a host?" ping.
 *
 * The imports proxy is returned *wrapped* in an object: a @quilted/threads
 * imports proxy has no `then` guard, so returning it bare from an async function
 * would make `Promise.resolve` thenable-check it — accessing `.then` and firing a
 * phantom remote `then()` call that rejects.
 */
async function connectToHost(): Promise<{
  host: ThreadImports<HostThread>;
} | null> {
  const framed = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  if (!framed) return null;

  const thread = ThreadWindow.parent<HostThread>({targetOrigin: HOST_ORIGIN});
  try {
    await withTimeout(thread.imports.listApps(), 2500);
    return {host: thread.imports};
  } catch {
    thread.close();
    return null;
  }
}

async function boot() {
  const connected = await connectToHost();
  createRoot(document.getElementById('root')!).render(
    <MapApp host={connected?.host} />,
  );
}

void boot();
