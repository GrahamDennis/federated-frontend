import {createRoot} from 'react-dom/client';
import {
  connectToHost,
  createHostedPlatform,
  createStandalonePlatform,
  PlatformProvider,
  RemoteContributions,
  StandaloneChrome,
} from '@ff/plugin-sdk-react';
import {Contributions} from './Contributions';
import {InAppUI} from './InAppUI';
import './styles.css';

async function boot() {
  const connected = await connectToHost();
  const root = createRoot(document.getElementById('root')!);

  if (connected) {
    // Hosted: the page is the in-iframe UI; the contributed tree is streamed to
    // the host declaratively via <RemoteContributions>.
    const platform = createHostedPlatform(connected.host);
    root.render(
      <PlatformProvider value={platform}>
        <InAppUI />
        <RemoteContributions connection={connected.connection}>
          <Contributions />
        </RemoteContributions>
      </PlatformProvider>,
    );
  } else {
    // Standalone: the plugin supplies its own chrome and renders contributions inline.
    const platform = createStandalonePlatform();
    root.render(
      <StandaloneChrome platform={platform}>
        <Contributions />
        <InAppUI />
      </StandaloneChrome>,
    );
  }
}

void boot();
