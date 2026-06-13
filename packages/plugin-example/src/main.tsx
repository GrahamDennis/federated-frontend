import {createRoot} from 'react-dom/client';
import {ThreadWindow} from '@quilted/threads';
import {HOST_ORIGIN, type HostThread} from '@ff/protocol';
import type {RemoteConnection} from '@remote-dom/core/elements';
import {PlatformProvider, type Platform} from './platform';
import {createHostedPlatform, RemoteContributions} from './kit-hosted';
import {createStandalonePlatform, StandaloneChrome} from './kit-standalone';
import {Contributions} from './Contributions';
import {InAppUI} from './InAppUI';
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

type Detected =
  | {mode: 'standalone'; platform: Platform}
  | {mode: 'hosted'; platform: Platform; connection: RemoteConnection};

/**
 * Decide how the plugin is running. Top-level => standalone. Framed => we might
 * be hosted, but only by something that speaks our protocol, so we attempt the
 * handshake (which also yields the remote-dom connection) and fall back to
 * standalone if no host answers in time.
 */
async function detect(): Promise<Detected> {
  const framed = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();

  if (framed) {
    const thread = ThreadWindow.parent<HostThread>({targetOrigin: HOST_ORIGIN});
    try {
      const connection = await withTimeout(thread.imports.connect(), 2500);
      return {
        mode: 'hosted',
        platform: createHostedPlatform(thread.imports),
        connection,
      };
    } catch {
      thread.close();
    }
  }

  return {mode: 'standalone', platform: createStandalonePlatform()};
}

async function boot() {
  const detected = await detect();
  const root = createRoot(document.getElementById('root')!);

  if (detected.mode === 'hosted') {
    // The page itself is the in-iframe UI; the contributed tree is streamed to
    // the host declaratively via <RemoteContributions>.
    root.render(
      <PlatformProvider value={detected.platform}>
        <InAppUI />
        <RemoteContributions connection={detected.connection}>
          <Contributions />
        </RemoteContributions>
      </PlatformProvider>,
    );
  } else {
    // The plugin supplies its own chrome and renders its contributions inline.
    root.render(
      <StandaloneChrome platform={detected.platform}>
        <Contributions />
        <InAppUI />
      </StandaloneChrome>,
    );
  }
}

void boot();
