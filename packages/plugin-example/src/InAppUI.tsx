import {useEffect, useState} from 'react';
import type {AppSummary} from '@ff/protocol';
import {usePlatform} from './platform';
import {useStore, setState} from './store';

/**
 * The plugin's own page content — rendered inside its iframe when hosted, and
 * inside its own standalone chrome otherwise. It uses the platform abstraction,
 * so the same code works in both modes; host-only capabilities are feature-
 * detected and degrade gracefully.
 */
export function InAppUI() {
  const platform = usePlatform();
  const modalOpen = useStore((s) => s.modalOpen);
  const [siblingApps, setSiblingApps] = useState<AppSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    platform.listApps?.().then(
      (apps) => {
        if (!cancelled) setSiblingApps(apps);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [platform]);

  return (
    <div className="app">
      <h1>📝 Example Notes Plugin</h1>
      <p>
        Running <strong>{platform.mode}</strong>.{' '}
        {platform.mode === 'hosted'
          ? 'Embedded in the host chrome via a sandboxed cross-origin iframe; toasts, commands, the toolbar, and the modal are all routed to the host.'
          : 'Loaded directly with no host, so the plugin provides its own chrome for toasts, commands, the toolbar, and the modal.'}
      </p>

      <div className="row">
        <button
          className="primary"
          onClick={() =>
            platform.toast('Hello from the Notes plugin', {tone: 'info'})
          }
        >
          Show a toast
        </button>
        <button onClick={() => setState({modalOpen: !modalOpen})}>
          {modalOpen ? 'Close the modal' : 'Open the modal'}
        </button>
      </div>

      <section className="switcher">
        <h2>Switch to another app</h2>
        {platform.switchApp ? (
          siblingApps.length > 0 ? (
            <div className="row">
              {siblingApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => platform.switchApp?.(app.id)}
                >
                  Open {app.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="unavailable">No other apps in the shell.</p>
          )
        ) : (
          <p className="unavailable">
            Only available when hosted — there's no surrounding shell to switch
            within while running standalone.
          </p>
        )}
      </section>

      <ul className="hint">
        <li>It contributes a toolbar section (to the chrome's top bar).</li>
        <li>
          It registers two <kbd>⌘K</kbd> command-palette entries.
        </li>
        <li>The details modal covers the whole window.</li>
      </ul>
    </div>
  );
}
