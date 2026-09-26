/// <reference types="vite/client" />

const SERVICE_URL = import.meta.env.VITE_LAYOUT_SERVICE_URL ?? 'http://localhost:5181';

export interface LayoutEvent {
  event: string;
  data: any;
}

/**
 * Subscribe to the layout service's server-sent events. Uses a streaming
 * `fetch` (not `EventSource`) so the bearer token travels in a header rather
 * than the URL. Reconnects with backoff if the stream drops; `onStatus`
 * reports whether it's currently connected. Returns an unsubscribe function.
 */
export function subscribeLayoutEvents(
  token: string,
  onEvent: (event: LayoutEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let retryMs = 1000;

  async function run() {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await fetch(`${SERVICE_URL}/v1/events`, {
          headers: {Authorization: `Bearer ${token}`},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        onStatus(true);
        retryMs = 1000;
        await readStream(res.body, onEvent);
      } catch {
        // Dropped or refused; retry below unless we've been closed.
      }
      onStatus(false);
      if (closed) return;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  void run();
  return () => {
    closed = true;
    controller?.abort();
  };
}

/** Parse an SSE byte stream: `event:` / `data:` lines, blank-line separated. */
async function readStream(body: ReadableStream<Uint8Array>, onEvent: (e: LayoutEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, {stream: true});
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length === 0) continue;
      try {
        onEvent({event, data: JSON.parse(data.join('\n'))});
      } catch {
        // Ignore malformed events.
      }
    }
  }
}
