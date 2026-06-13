import type {ComponentType, ReactNode} from 'react';
import {createRemoteComponent} from '@remote-dom/react';
import {
  ELEMENT_TAGS,
  StackElement,
  TextElement,
  ButtonElement,
  ModalElement,
  ToolbarSectionElement,
} from '@ff/protocol/elements';

/**
 * Register the shared kit as real custom elements in this iframe, then wrap each
 * in a React component. When the plugin renders `<Button>`, remote-dom creates an
 * inert `<ui-button>` element here; the RemoteMutationObserver serializes it and
 * the *host* renders its own `HostButton` for it. The plugin never runs the host's
 * rendering code — it only describes the tree.
 */
function define(tag: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

define(ELEMENT_TAGS.stack, StackElement);
define(ELEMENT_TAGS.text, TextElement);
define(ELEMENT_TAGS.button, ButtonElement);
define(ELEMENT_TAGS.modal, ModalElement);
define(ELEMENT_TAGS.toolbarSection, ToolbarSectionElement);

// `createRemoteComponent`'s return type doesn't surface event-listener props
// (`onPress`, `onClose`) even though, with `eventProps`, they work at runtime by
// calling `addEventListener`. We re-assert the prop types here so callers get
// proper checking. (See the runtime in @remote-dom/react's component.mjs.)
type StackProps = {
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children?: ReactNode;
};
type TextProps = {tone?: 'default' | 'subdued'; children?: ReactNode};
type ButtonProps = {
  tone?: 'default' | 'primary' | 'critical';
  disabled?: boolean;
  onPress?: () => void;
  children?: ReactNode;
};
type ModalProps = {
  open?: boolean;
  heading?: string;
  onClose?: () => void;
  children?: ReactNode;
};
type ToolbarSectionProps = {label?: string; children?: ReactNode};

export const Stack = createRemoteComponent(
  ELEMENT_TAGS.stack,
  StackElement,
) as unknown as ComponentType<StackProps>;

export const Text = createRemoteComponent(
  ELEMENT_TAGS.text,
  TextElement,
) as unknown as ComponentType<TextProps>;

export const Button = createRemoteComponent(ELEMENT_TAGS.button, ButtonElement, {
  eventProps: {onPress: {event: 'press'}},
}) as unknown as ComponentType<ButtonProps>;

export const Modal = createRemoteComponent(ELEMENT_TAGS.modal, ModalElement, {
  eventProps: {onClose: {event: 'close'}},
}) as unknown as ComponentType<ModalProps>;

export const ToolbarSection = createRemoteComponent(
  ELEMENT_TAGS.toolbarSection,
  ToolbarSectionElement,
) as unknown as ComponentType<ToolbarSectionProps>;
