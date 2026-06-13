import {MAP_PLUGIN_ORIGIN, PLUGIN_ORIGIN} from '@ff/protocol';

/**
 * An app the chrome can host. `plugin` apps integrate with the chrome over the
 * capability + remote-dom channels; `external` apps are just sandboxed iframes
 * with no integration at all.
 */
export interface AppDescriptor {
  id: string;
  name: string;
  kind: 'plugin' | 'external';
  src: string;
  description?: string;
}

export const APPS: AppDescriptor[] = [
  {
    id: 'example-notes',
    name: 'Example Notes',
    kind: 'plugin',
    src: PLUGIN_ORIGIN,
    description:
      'An integrated plugin: it contributes a toolbar section, ⌘K commands, toasts, and a whole-window modal to this chrome.',
  },
  {
    id: 'world-map',
    name: 'World Map',
    kind: 'plugin',
    src: MAP_PLUGIN_ORIGIN,
    description:
      'A MapLibre GL map (an integrated plugin). It uses only the capability API: it registers ⌘K fly-to commands and raises toasts, with no remote-dom contributions.',
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'external',
    // Plain https://google.com refuses to be framed (X-Frame-Options / CSP
    // frame-ancestors). `?igu=1` is Google's frameable embed endpoint, used here
    // purely to demonstrate a non-integrated external app in the same chrome.
    src: 'https://www.google.com/webhp?igu=1',
    description:
      'A plain external website with no host integration — it cannot contribute toolbars, commands, toasts, or modals.',
  },
];
