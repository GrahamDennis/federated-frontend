import {createRemoteElement} from '@remote-dom/core/elements';

/**
 * The shared "component kit" contract. Both the host and the plugin import these
 * definitions so the tag names, properties and events stay in lockstep:
 *
 *  - The **plugin** registers them as real custom elements and renders them
 *    (`@remote-dom/react`'s `createRemoteComponent`). It only ever builds an
 *    inert element tree — it never gets to run the host's rendering code.
 *  - The **host** maps each tag name to a real, host-controlled React component
 *    (`createRemoteComponentRenderer`). The host decides what these actually look
 *    like and *where in the host DOM they render* — which is how a plugin's
 *    contributions can escape the iframe (toolbar, whole-window modal).
 */

export const ELEMENT_TAGS = {
  stack: 'ui-stack',
  text: 'ui-text',
  button: 'ui-button',
  modal: 'ui-modal',
  toolbarSection: 'ui-toolbar-section',
} as const;

export const StackElement = createRemoteElement<{
  direction?: 'vertical' | 'horizontal';
  gap?: number;
}>({
  properties: {
    direction: {type: String},
    gap: {type: Number},
  },
});

export const TextElement = createRemoteElement<{
  tone?: 'default' | 'subdued';
}>({
  properties: {
    tone: {type: String},
  },
});

export const ButtonElement = createRemoteElement<
  {tone?: 'default' | 'primary' | 'critical'; disabled?: boolean},
  {},
  {},
  {press: {}}
>({
  properties: {
    tone: {type: String},
    disabled: {type: Boolean},
  },
  events: {press: {}},
});

export const ModalElement = createRemoteElement<
  {open?: boolean; heading?: string},
  {},
  {},
  {close: {}}
>({
  properties: {
    open: {type: Boolean},
    heading: {type: String},
  },
  events: {close: {}},
});

export const ToolbarSectionElement = createRemoteElement<{
  label?: string;
}>({
  properties: {
    label: {type: String},
  },
});

declare global {
  interface HTMLElementTagNameMap {
    'ui-stack': InstanceType<typeof StackElement>;
    'ui-text': InstanceType<typeof TextElement>;
    'ui-button': InstanceType<typeof ButtonElement>;
    'ui-modal': InstanceType<typeof ModalElement>;
    'ui-toolbar-section': InstanceType<typeof ToolbarSectionElement>;
  }
}
