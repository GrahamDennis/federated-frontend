import {createRoot} from 'react-dom/client';
import {ThreadWindow} from '@quilted/threads';
import type {ThreadImports} from '@quilted/threads';
import {HOST_ORIGIN, type HostThread} from '@ff/protocol';
import {PlacesApp} from './PlacesApp';
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
 * The imports proxy is returned wrapped (never bare from an async function) so
 * `Promise.resolve` doesn't thenable-check it and fire a phantom remote `then()`.
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
    await withTimeout(thread.imports.getContext(), 2500);
    return {host: thread.imports};
  } catch {
    thread.close();
    return null;
  }
}

async function boot() {
  const connected = await connectToHost();
  createRoot(document.getElementById('root')!).render(
    <PlacesApp host={connected?.host} />,
  );
}

void boot();
