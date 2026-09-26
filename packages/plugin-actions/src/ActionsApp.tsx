import {useState} from 'react';
import type {Host} from '@ff/plugin-sdk-react/connect';
import {useHostInputs, useHostSettings} from '@ff/plugin-sdk-react/settings';
import type {ButtonSpec} from '@ff/protocol';

/** Mirrors the defaults declared in `public/ff-plugin.json#settings`. */
const DEFAULT_SETTINGS = {title: 'Actions', layout: 'column'};

/** Shown standalone (no host to wire buttons in). */
const STANDALONE_BUTTONS: ButtonSpec[] = [{label: 'Example button', value: 'example'}];

function asButtons(value: unknown): ButtonSpec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is ButtonSpec => Boolean(b) && typeof b === 'object' && typeof b.label === 'string',
  );
}

/**
 * An action-button block. The layout author supplies the buttons through the
 * `buttons` input (typically a CEL list). Pressing a button:
 *
 *  - publishes its `value` on the `pressed` output (and its label on
 *    `pressedLabel`), so it can drive any wired block; and/or
 *  - asks the host to run its `command` — which the host only does because the
 *    author put that command reference in this block's inputs.
 *
 * The plugin itself holds no authority: it can only use what it was wired.
 */
export function ActionsApp({host}: {host?: Host}) {
  const settings = useHostSettings(host, DEFAULT_SETTINGS);
  const inputs = useHostInputs(host);
  const wired = 'buttons' in inputs;
  const buttons = host ? asButtons(inputs.buttons) : STANDALONE_BUTTONS;
  const [last, setLast] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function press(button: ButtonSpec) {
    setLast(button.label);
    setStatus(null);
    if (button.value !== undefined) {
      void host?.publish('pressed', button.value ?? null);
      void host?.publish('pressedLabel', button.label);
    }
    if (button.command && host) {
      const ran = await host.runCommand(button.command);
      if (!ran) setStatus(`Couldn’t run ${button.command.block}:${button.command.command}`);
    }
  }

  return (
    <div className="actions">
      <header className="actions-header">
        <h1>⚡ {settings.title}</h1>
        {wired && <span className="actions-badge">wired</span>}
      </header>
      {buttons.length === 0 ? (
        <p className="actions-empty">
          {wired
            ? 'The connected button list is empty (or not valid).'
            : 'No buttons yet — connect the Buttons input (e.g. to a CEL list) in edit mode.'}
        </p>
      ) : (
        <div className={`actions-buttons ${settings.layout === 'row' ? 'row' : 'column'}`}>
          {buttons.map((button, i) => (
            <button
              key={`${i}:${button.label}`}
              className={button.label === last ? 'last' : ''}
              onClick={() => void press(button)}
            >
              {button.command && <span className="actions-kind" aria-hidden>▶</span>}
              {button.label}
            </button>
          ))}
        </div>
      )}
      {status && <p className="actions-status">{status}</p>}
    </div>
  );
}
