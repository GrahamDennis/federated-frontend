import {createRoot} from 'react-dom/client';
import {ThreadWindow} from '@quilted/threads';
import {HOST_ORIGIN, type CommandDescriptor, type HostThread} from '@ff/protocol';
import {PlatformProvider, type Platform} from './platform';
import {createHostedPlatform} from './kit-hosted';
import {createStandalonePlatform, StandaloneChrome} from './kit-standalone';
import {Contributions} from './Contributions';
import {InAppUI} from './InAppUI';
import {setState} from './store';
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
 * Decide how the plugin is running. If we're top-level we're definitely
 * standalone. If we're framed we *might* be hosted, but only by something that
 * speaks our protocol — so we attempt the handshake and fall back to standalone
 * if no host answers in time (e.g. embedded by an unrelated page).
 */
async function detectPlatform(): Promise<Platform> {
  const framed = (() => {
    try {
      return window.top !== window.self;
    } catch {
      // Cross-origin parent: we're definitely framed.
      return true;
    }
  })();

  if (framed) {
    const thread = ThreadWindow.parent<HostThread>({targetOrigin: HOST_ORIGIN});
    try {
      const connection = await withTimeout(thread.imports.connect(), 2500);
      return createHostedPlatform(thread.imports, connection);
    } catch {
      thread.close();
    }
  }

  return createStandalonePlatform();
}

async function boot() {
  const platform = await detectPlatform();

  // Register command-palette entries (host palette when hosted; the plugin's own
  // palette when standalone).
  const commands: CommandDescriptor[] = [
    {
      id: 'notes.hello',
      title: 'Notes: Say hello',
      subtitle: 'Show a toast',
      run: () =>
        platform.toast('👋 Hello from the example plugin!', {tone: 'success'}),
    },
    {
      id: 'notes.details',
      title: 'Notes: Open details',
      subtitle: 'Open the details modal',
      run: () => setState({modalOpen: true}),
    },
  ];
  platform.setCommands(commands);

  const root = createRoot(document.getElementById('root')!);
  if (platform.mode === 'standalone') {
    // The plugin supplies its own chrome and renders its contributions inline.
    root.render(
      <StandaloneChrome platform={platform}>
        <Contributions />
        <InAppUI />
      </StandaloneChrome>,
    );
  } else {
    // Hosted: this page is just the in-iframe UI. The contributed tree was
    // already mounted into the remote-dom container by createHostedPlatform.
    root.render(
      <PlatformProvider value={platform}>
        <InAppUI />
      </PlatformProvider>,
    );
  }
}

void boot();
