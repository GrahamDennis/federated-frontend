import {createRoot} from 'react-dom/client';
import {ThreadWindow} from '@quilted/threads';
import {RemoteMutationObserver} from '@remote-dom/core/elements';
import {HOST_ORIGIN, type CommandDescriptor, type HostThread} from '@ff/protocol';
import {InAppUI} from './InAppUI';
import {Contributions} from './Contributions';
import {setHost} from './hostApi';
import {setState} from './store';
import './styles.css';

async function boot() {
  // Connect to the host chrome. Because the host has been listening since it
  // created our iframe, the plugin can safely send the first message.
  const thread = ThreadWindow.parent<HostThread>({targetOrigin: HOST_ORIGIN});
  const host = thread.imports;
  setHost(host);

  // 1. Render the plugin's own UI inside the iframe (no host needed for this).
  createRoot(document.getElementById('root')!).render(<InAppUI />);

  // 2. Capability API — contribute command-palette entries. The `run` callbacks
  //    are proxied back to us by threads when the user picks them in the host.
  const commands: CommandDescriptor[] = [
    {
      id: 'notes.hello',
      title: 'Notes: Say hello',
      subtitle: 'Plugin command → host-rendered toast',
      run: () => void host.toast('👋 Hello from the example plugin!', {tone: 'success'}),
    },
    {
      id: 'notes.details',
      title: 'Notes: Open details',
      subtitle: 'Opens a whole-window modal rendered by the host',
      run: () => setState({modalOpen: true}),
    },
  ];
  void host.setCommands(commands);

  // 3. remote-dom — pull the host's connection and stream our contributed tree
  //    (toolbar section + modal) to it. We observe a detached container so only
  //    the contribution tree crosses the boundary, not the in-iframe UI above.
  const connection = await host.connect();
  const container = document.createElement('div');
  const observer = new RemoteMutationObserver(connection);
  observer.observe(container);
  createRoot(container).render(<Contributions />);
}

void boot();
