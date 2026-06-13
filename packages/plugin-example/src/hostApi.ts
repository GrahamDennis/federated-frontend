import type {HostThread} from '@ff/protocol';

/**
 * The host's API, as a set of async proxies created by @quilted/threads. Set once
 * during boot and read by the plugin's components when they want to invoke a
 * host capability (toast, etc.).
 */
let host: HostThread | undefined;

export function setHost(value: HostThread): void {
  host = value;
}

export function getHost(): HostThread {
  if (!host) throw new Error('Host is not connected yet');
  return host;
}
