import {createPortal} from 'react-dom';
import type {ComponentType, ReactNode} from 'react';
import {createRemoteComponentRenderer} from '@remote-dom/react/host';
import {ELEMENT_TAGS} from '@ff/protocol/elements';
import {useChrome} from './chrome';

/**
 * Host-controlled implementations of the shared component kit. The plugin only
 * ever describes *which* of these to render and with what props/children — the
 * host decides what they look like and, crucially, *where they render*. Toolbar
 * sections and modals use React portals to escape the plugin's iframe and draw
 * into the host chrome.
 */

function HostStack({
  direction = 'vertical',
  gap = 8,
  children,
}: {
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children?: ReactNode;
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
  children?: ReactNode;
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
  children?: ReactNode;
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
  children?: ReactNode;
}) {
  const {toolbarSlot} = useChrome();
  if (!toolbarSlot) return null;
  return createPortal(
    <div className="toolbar-section">
      {label && <span className="toolbar-section-label">{label}</span>}
      {children}
    </div>,
    toolbarSlot,
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
  children?: ReactNode;
}) {
  const {modalLayer} = useChrome();
  if (!open || !modalLayer) return null;
  return createPortal(
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
    </div>,
    modalLayer,
  );
}

/**
 * The map handed to `<RemoteRootRenderer>`. `eventProps` wires a React `on*`
 * prop on the host component to a named event dispatched back to the plugin.
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
