import type {AppDescriptor} from './apps';
import {PluginHost} from './PluginHost';

/**
 * Renders an app inside a titlebar "card". Integrated plugins go through
 * {@link PluginHost} (which wires up the thread + remote-dom); external apps are
 * plain sandboxed iframes with no channel to the host.
 *
 * `active` indicates whether this app is currently in the foreground. The app
 * stays mounted regardless (kept alive by the chrome), but plugins only surface
 * their contributed UI while active.
 */
export function AppView({app, active}: {app: AppDescriptor; active: boolean}) {
  return (
    <section className="app-card">
      <div className="app-titlebar">
        <span className={`app-dot ${app.kind}`} />
        <span className="app-titlebar-name">{app.name}</span>
        <span className="app-titlebar-origin">{new URL(app.src).origin}</span>
        <span className={`app-badge ${app.kind}`}>
          {app.kind === 'plugin'
            ? 'integrated plugin'
            : 'external · no integration'}
        </span>
      </div>

      {app.kind === 'plugin' ? (
        <PluginHost pluginId={app.id} src={app.src} active={active} />
      ) : (
        <div className="app-frame">
          <iframe
            src={app.src}
            title={app.id}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      )}
    </section>
  );
}
