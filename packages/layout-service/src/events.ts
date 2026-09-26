/** An event sent to connected clients (server-sent events). */
export interface HubEvent {
  event: string;
  data: unknown;
}

/** Someone currently editing a view (from their live connection). */
export interface Presence {
  connId: string;
  user: string;
  name: string;
  viewId: string;
}

interface Connection {
  user: string;
  name: string;
  editing: string | null;
  send: (event: HubEvent) => void;
}

/**
 * Live connections per workspace, for pushing changes and presence. Presence
 * is tied to a connection: when the stream closes (tab closed, network gone),
 * that client's "editing" marker disappears with it — no heartbeats needed.
 */
export class EventHub {
  private readonly workspaces = new Map<string, Map<string, Connection>>();
  private nextId = 1;

  connect(ws: string, user: string, name: string, send: (event: HubEvent) => void): string {
    const connId = `c${this.nextId++}-${Math.random().toString(36).slice(2, 8)}`;
    const conns = this.workspaces.get(ws) ?? new Map<string, Connection>();
    conns.set(connId, {user, name, editing: null, send});
    this.workspaces.set(ws, conns);
    return connId;
  }

  disconnect(ws: string, connId: string): void {
    const conns = this.workspaces.get(ws);
    const had = conns?.get(connId)?.editing;
    conns?.delete(connId);
    if (conns?.size === 0) this.workspaces.delete(ws);
    if (had) this.broadcastPresence(ws);
  }

  /** Mark what a connection is editing (null = nothing). Only its own user may. */
  setEditing(ws: string, connId: string, user: string, viewId: string | null): boolean {
    const conn = this.workspaces.get(ws)?.get(connId);
    if (!conn || conn.user !== user) return false;
    if (conn.editing !== viewId) {
      conn.editing = viewId;
      this.broadcastPresence(ws);
    }
    return true;
  }

  presence(ws: string): Presence[] {
    return [...(this.workspaces.get(ws) ?? new Map<string, Connection>())].flatMap(([connId, c]) =>
      c.editing ? [{connId, user: c.user, name: c.name, viewId: c.editing}] : [],
    );
  }

  broadcast(ws: string, event: HubEvent): void {
    for (const conn of this.workspaces.get(ws)?.values() ?? []) conn.send(event);
  }

  private broadcastPresence(ws: string): void {
    this.broadcast(ws, {event: 'presence', data: this.presence(ws)});
  }
}
