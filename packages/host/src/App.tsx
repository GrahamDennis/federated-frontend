import {PLUGIN_ORIGIN} from '@ff/protocol';
import {Chrome} from './chrome';
import {PluginHost} from './PluginHost';

/**
 * In a real product this list would come from a plugin registry / marketplace.
 * Each entry is served from its own origin and loaded into a sandboxed iframe.
 */
const PLUGINS = [{id: 'example-notes', src: PLUGIN_ORIGIN}];

export function App() {
  return (
    <Chrome>
      <div className="workspace">
        <p className="workspace-hint">
          The panel below is an untrusted third-party plugin running in a
          cross-origin sandboxed iframe. It talks to this chrome over{' '}
          <code>@quilted/threads</code> (capability RPC: toasts, command-palette
          entries) and <code>remote-dom</code> (contributed component trees:
          toolbar section + whole-window modal). Try <kbd>⌘K</kbd>.
        </p>
        {PLUGINS.map((plugin) => (
          <PluginHost key={plugin.id} pluginId={plugin.id} src={plugin.src} />
        ))}
      </div>
    </Chrome>
  );
}
