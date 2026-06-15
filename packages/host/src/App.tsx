import {useEffect, useState} from 'preact/hooks';
import {Chrome} from './chrome';
import {fetchApps, type AppDescriptor} from './apps';

type LoadState =
  | {status: 'loading'}
  | {status: 'error'; message: string}
  | {status: 'ready'; apps: AppDescriptor[]};

export function App() {
  // The chrome embeds no per-plugin knowledge: it discovers the available apps
  // from the plugin registry at boot. Until they arrive (and the workspace URL
  // can be resolved against them) we render a lightweight placeholder.
  const [state, setState] = useState<LoadState>({status: 'loading'});

  useEffect(() => {
    let cancelled = false;
    fetchApps()
      .then((apps) => !cancelled && setState({status: 'ready', apps}))
      .catch((err) => !cancelled && setState({status: 'error', message: String(err)}));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <div className="boot">Loading plugins…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="boot boot-error">
        <p>Couldn’t reach the plugin registry.</p>
        <pre>{state.message}</pre>
        <p>Is it running? <code>npm run dev -w @ff/plugin-registry</code></p>
      </div>
    );
  }
  return <Chrome apps={state.apps} />;
}
