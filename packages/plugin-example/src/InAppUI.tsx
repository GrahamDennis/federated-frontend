import {useStore, setState} from './store';
import {getHost} from './hostApi';

/**
 * The plugin's own UI, rendered normally inside its iframe (origin :5174). This
 * is the part confined to the iframe's rectangle. Everything that needs to
 * escape that rectangle goes through the host (see Contributions / commands).
 */
export function InAppUI() {
  const modalOpen = useStore((s) => s.modalOpen);

  return (
    <div className="app">
      <h1>📝 Example Notes Plugin</h1>
      <p>
        This document is an <strong>untrusted third-party app</strong> running in
        a sandboxed, cross-origin iframe (<code>localhost:5174</code>). It cannot
        touch the host DOM directly — only the negotiated channels.
      </p>

      <div className="row">
        <button
          className="primary"
          onClick={() =>
            void getHost().toast('Hello from inside the iframe!', {tone: 'info'})
          }
        >
          Trigger a host toast
        </button>
        <button onClick={() => setState({modalOpen: !modalOpen})}>
          {modalOpen ? 'Close' : 'Open'} host modal
        </button>
      </div>

      <ul className="hint">
        <li>It contributed a toolbar section to the top of the chrome.</li>
        <li>
          It registered two <kbd>⌘K</kbd> command-palette entries.
        </li>
        <li>The modal it opens is rendered by the host over the whole window.</li>
      </ul>
    </div>
  );
}
