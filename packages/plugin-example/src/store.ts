import {useSyncExternalStore} from 'react';

/**
 * A tiny shared store. The plugin renders two React roots in the same iframe
 * realm — its own in-iframe UI and the remote-dom contribution tree — and both
 * read/write this state, so e.g. toggling the modal from the toolbar button (in
 * the chrome) or from the in-iframe button stays in sync.
 */
interface PluginState {
  modalOpen: boolean;
}

let state: PluginState = {modalOpen: false};
const listeners = new Set<() => void>();

export function getState(): PluginState {
  return state;
}

export function setState(partial: Partial<PluginState>): void {
  state = {...state, ...partial};
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (state: PluginState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}
