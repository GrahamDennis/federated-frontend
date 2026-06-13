import {useEffect, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {createRemoteComponent} from '@remote-dom/react';
import {RemoteMutationObserver} from '@remote-dom/core/elements';
import type {RemoteConnection} from '@remote-dom/core/elements';
import type {ThreadImports} from '@quilted/threads';
import {forwardKeyboardShortcuts, type HostThread} from '@ff/protocol';
import {
  ELEMENT_TAGS,
  StackElement,
  TextElement,
  ButtonElement,
  ModalElement,
  ToolbarSectionElement,
} from '@ff/protocol/elements';
import {
  type ComponentKit,
  type Platform,
} from './platform';

/**
 * Hosted mode. The shared component kit is implemented with remote-dom: the
 * plugin builds an inert element tree that the host renders (and places) with
 * its own components. See `@ff/protocol/elements` for the shared definitions.
 */

function define(tag: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

define(ELEMENT_TAGS.stack, StackElement);
define(ELEMENT_TAGS.text, TextElement);
define(ELEMENT_TAGS.button, ButtonElement);
define(ELEMENT_TAGS.modal, ModalElement);
define(ELEMENT_TAGS.toolbarSection, ToolbarSectionElement);

// `createRemoteComponent`'s return type omits event-listener props (`onPress`,
// `onClose`) even though `eventProps` wires them at runtime, so we re-assert the
// kit's prop types via a cast.
const hostedKit: ComponentKit = {
  Stack: createRemoteComponent(
    ELEMENT_TAGS.stack,
    StackElement,
  ) as unknown as ComponentKit['Stack'],
  Text: createRemoteComponent(
    ELEMENT_TAGS.text,
    TextElement,
  ) as unknown as ComponentKit['Text'],
  Button: createRemoteComponent(ELEMENT_TAGS.button, ButtonElement, {
    eventProps: {onPress: {event: 'press'}},
  }) as unknown as ComponentKit['Button'],
  Modal: createRemoteComponent(ELEMENT_TAGS.modal, ModalElement, {
    eventProps: {onClose: {event: 'close'}},
  }) as unknown as ComponentKit['Modal'],
  Toolbar: createRemoteComponent(
    ELEMENT_TAGS.toolbarSection,
    ToolbarSectionElement,
  ) as unknown as ComponentKit['Toolbar'],
};

export function createHostedPlatform(host: ThreadImports<HostThread>): Platform {
  // Relay ⌘K/Escape etc. so host shortcuts work while this iframe has focus.
  forwardKeyboardShortcuts(host);
  return {
    mode: 'hosted',
    toast: (message, options) => void host.toast(message, options),
    setCommands: (commands) => void host.setCommands(commands),
    components: hostedKit,
    listApps: () => host.listApps(),
    switchApp: (appId) => void host.activateApp(appId),
  };
}

/**
 * Streams its `children` (a remote-dom tree built from the hosted kit) to the
 * host over `connection`, declaratively. Rendering it as part of the React tree
 * means React owns its lifecycle: the observer is created on mount and, on
 * unmount, `disconnect({empty: true})` removes the contributed tree from the
 * host. That's what keeps HMR / Fast Refresh from stacking duplicate toolbars —
 * the old tree is torn down before a new one is observed.
 */
export function RemoteContributions({
  connection,
  children,
}: {
  connection: RemoteConnection;
  children: ReactNode;
}) {
  // A stable detached container the children are portaled into and the observer
  // watches. Only the contribution tree crosses the boundary — not the plugin's
  // own in-iframe UI.
  const [container] = useState(() => document.createElement('div'));

  useEffect(() => {
    const observer = new RemoteMutationObserver(connection);
    observer.observe(container);
    return () => observer.disconnect({empty: true});
  }, [connection, container]);

  return createPortal(children, container);
}
