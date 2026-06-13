import {createRoot} from 'react-dom/client';
import {createRemoteComponent} from '@remote-dom/react';
import {RemoteMutationObserver} from '@remote-dom/core/elements';
import type {RemoteConnection} from '@remote-dom/core/elements';
import type {ThreadImports} from '@quilted/threads';
import type {HostThread} from '@ff/protocol';
import {
  ELEMENT_TAGS,
  StackElement,
  TextElement,
  ButtonElement,
  ModalElement,
  ToolbarSectionElement,
} from '@ff/protocol/elements';
import {Contributions} from './Contributions';
import {
  PlatformProvider,
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

/**
 * Build the hosted platform and start streaming the plugin's contributed
 * component tree to the host over the given remote-dom connection.
 */
export function createHostedPlatform(
  host: ThreadImports<HostThread>,
  connection: RemoteConnection,
): Platform {
  const platform: Platform = {
    mode: 'hosted',
    toast: (message, options) => void host.toast(message, options),
    setCommands: (commands) => void host.setCommands(commands),
    components: hostedKit,
    listApps: () => host.listApps(),
    switchApp: (appId) => void host.activateApp(appId),
  };

  // Observe a detached container so only the contribution tree crosses the
  // boundary (not the plugin's own in-iframe UI).
  const container = document.createElement('div');
  const observer = new RemoteMutationObserver(connection);
  observer.observe(container);
  createRoot(container).render(
    <PlatformProvider value={platform}>
      <Contributions />
    </PlatformProvider>,
  );

  return platform;
}
