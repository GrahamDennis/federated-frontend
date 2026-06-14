import {render, type ComponentChildren, type ComponentType} from 'preact';
import {useEffect} from 'preact/hooks';
import {createRemoteComponentRenderer} from '@remote-dom/preact/host';
import {ELEMENT_TAGS} from '@ff/protocol/elements';
import {useChrome} from './chrome';

/**
 * Host-controlled implementations of the shared component kit — in **Preact**,
 * while the plugins author their trees in **React 19**. The plugin only ever
 * describes *which* of these to render and with what props/children; the host
 * (a different framework, different version) decides what they look like and
 * where they render. The remote-dom connection is the framework-agnostic bridge.
 *
 * Toolbar sections and modals portal into the chrome to escape the plugin pane.
 */

/**
 * A minimal Preact portal — no `preact/compat`. Renders `children` into `into`
 * via a nested Preact render. Safe here because the targets (`toolbarSlot` /
 * `modalLayer`) are leaf nodes the main tree never renders children into, so the
 * two renders never fight over the container.
 */
function Portal({
  into,
  children,
}: {
  into: HTMLElement;
  children: ComponentChildren;
}) {
  // Keep the portal contents in sync on every render (Preact diffs against the
  // previous nested render into the same container — no remount).
  useEffect(() => {
    render(<>{children}</>, into);
  });
  // Tear the nested tree down when the portal unmounts.
  useEffect(() => () => render(null, into), [into]);
  return null;
}

function HostStack({
  direction = 'vertical',
  gap = 8,
  children,
}: {
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children?: ComponentChildren;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction === 'horizontal' ? 'row' : 'column',
        gap,
        alignItems: direction === 'horizontal' ? 'center' : 'stretch',
      }}
    >
      {children}
    </div>
  );
}

function HostText({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'subdued';
  children?: ComponentChildren;
}) {
  return (
    <span style={{color: tone === 'subdued' ? 'var(--subdued)' : 'inherit'}}>
      {children}
    </span>
  );
}

function HostButton({
  tone = 'default',
  disabled = false,
  onPress,
  children,
}: {
  tone?: 'default' | 'primary' | 'critical';
  disabled?: boolean;
  onPress?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <button
      className={`btn btn-${tone}`}
      disabled={disabled}
      onClick={() => onPress?.()}
    >
      {children}
    </button>
  );
}

function HostToolbarSection({
  label,
  children,
}: {
  label?: string;
  children?: ComponentChildren;
}) {
  const {toolbarSlot} = useChrome();
  if (!toolbarSlot) return null;
  return (
    <Portal into={toolbarSlot}>
      <div className="toolbar-section">
        {label && <span className="toolbar-section-label">{label}</span>}
        {children}
      </div>
    </Portal>
  );
}

function HostModal({
  open = false,
  heading,
  onClose,
  children,
}: {
  open?: boolean;
  heading?: string;
  onClose?: () => void;
  children?: ComponentChildren;
}) {
  const {modalLayer} = useChrome();
  if (!open || !modalLayer) return null;
  return (
    <Portal into={modalLayer}>
      <div className="modal-backdrop" onClick={() => onClose?.()}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <header className="modal-header">
            <h2>{heading}</h2>
            <button className="modal-close" onClick={() => onClose?.()}>
              ×
            </button>
          </header>
          <div className="modal-body">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The map handed to `<RemoteRootRenderer>`. `eventProps` wires an `on*` prop on
 * the host (Preact) component to a named event dispatched back to the plugin.
 */
export const components = new Map<string, ComponentType<any>>([
  [ELEMENT_TAGS.stack, createRemoteComponentRenderer(HostStack)],
  [ELEMENT_TAGS.text, createRemoteComponentRenderer(HostText)],
  [
    ELEMENT_TAGS.button,
    createRemoteComponentRenderer(HostButton, {
      eventProps: {onPress: {event: 'press'}},
    }),
  ],
  [
    ELEMENT_TAGS.modal,
    createRemoteComponentRenderer(HostModal, {
      eventProps: {onClose: {event: 'close'}},
    }),
  ],
  [ELEMENT_TAGS.toolbarSection, createRemoteComponentRenderer(HostToolbarSection)],
]);
