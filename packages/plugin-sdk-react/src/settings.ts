import {useEffect, useState} from 'react';
import type {BlockInputs, BlockSettings, InstanceInfo} from '@ff/protocol';
import type {Host} from './connect';

/**
 * This plugin instance's settings, kept live. Hosted, it reads the values the
 * layout author chose (the host merges them over the manifest defaults) and
 * re-renders when they change. Standalone (no host) it just returns `defaults`.
 *
 * `defaults` should mirror the manifest's declared defaults so the plugin
 * behaves the same standalone and before the first host reply arrives.
 */
export function useHostSettings<T extends BlockSettings>(
  host: Host | undefined,
  defaults: T,
): T {
  const [settings, setSettings] = useState<T>(defaults);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const apply = (next: BlockSettings) => {
      if (!cancelled) setSettings({...defaults, ...next});
    };
    void (async () => {
      apply(await host.getSettings());
      const off = await host.subscribeSettings(apply);
      if (cancelled) off();
      else unsubscribe = off;
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // `defaults` is expected to be a module-level constant, so only `host` is a dep.
  }, [host]);

  return settings;
}

/** Which instance of the plugin this is (null standalone / until known). */
export function useInstanceInfo(host: Host | undefined): InstanceInfo | null {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void host.getInstance().then((next) => !cancelled && setInfo(next));
    return () => {
      cancelled = true;
    };
  }, [host]);
  return info;
}

/**
 * This instance's wired inputs, kept live. Only inputs the layout connects are
 * present as keys (`null` until the source publishes); standalone, or when
 * nothing is wired, it's `{}` — so check `'name' in inputs` to decide whether to
 * follow the input or fall back to the plugin's own behaviour.
 */
export function useHostInputs(host: Host | undefined): BlockInputs {
  const [inputs, setInputs] = useState<BlockInputs>({});

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const apply = (next: BlockInputs) => {
      if (!cancelled) setInputs(next);
    };
    void (async () => {
      apply(await host.getInputs());
      const off = await host.subscribeInputs(apply);
      if (cancelled) off();
      else unsubscribe = off;
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host]);

  return inputs;
}
