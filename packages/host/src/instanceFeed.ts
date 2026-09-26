import {useCallback, useEffect, useRef} from 'preact/hooks';

/**
 * A per-instance value pushed to plugins: read synchronously via `get(id)`
 * (backed by the latest render) and broadcast to subscribers after any render
 * in which an instance's value changed (and once on subscribe). Used for block
 * settings and wired inputs, which both derive from host state on every render.
 */
export function useInstanceFeed<T>(ids: readonly string[], compute: (id: string) => T) {
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const subscribers = useRef(new Map<string, Set<(value: T) => void>>());
  const last = useRef(new Map<string, string>());

  useEffect(() => {
    for (const id of ids) {
      const value = computeRef.current(id);
      const json = JSON.stringify(value);
      if (last.current.get(id) === json) continue;
      last.current.set(id, json);
      for (const listener of subscribers.current.get(id) ?? []) listener(value);
    }
  });

  const get = useCallback((id: string) => computeRef.current(id), []);
  const subscribe = useCallback((id: string, listener: (value: T) => void) => {
    const listeners = subscribers.current.get(id) ?? new Set();
    listeners.add(listener);
    subscribers.current.set(id, listeners);
    // Plugins read, then subscribe, in two thread round trips; replay the
    // current value so a change landing in between isn't lost.
    listener(computeRef.current(id));
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {get, subscribe};
}
