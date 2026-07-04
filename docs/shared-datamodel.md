# A shared, extensible datamodel for federated plugins

**Status:** design sketch / RFC. No code yet.

## The problem

The prototype already lets plugins *contribute UI* (remote-dom trees) and *call
capabilities* (`toast`, `setCommands`) across the iframe boundary. What it does
**not** yet have is a principled way to share **data** — an extensible model that
plugins can both read and extend:

- A plugin contributes **map layers** to a host map.
- A plugin **observes selection state** owned by the host.
- A plugin wants to **change** selection state (the map picks a place; a "search"
  plugin wants to drive the same selection).
- Plugins **discover** each other's contributed data (all layers, all annotations)
  without the host hardcoding them.

Today this is a single opaque bag: `getContext()` / `setContext(patch)` /
`subscribeContext()` on `HostThread` (`packages/protocol/src/index.ts`). It works
for one shared `selectedPlace`, but it has two problems that will bite as soon as
more than two apps share more than one thing:

1. **No schema, no extensibility story.** The shape (`SharedContext`) is agreed
   out-of-band; there is no way for a plugin to *contribute* a new kind of shared
   data that other plugins can then discover and observe.
2. **Unmediated multi-writer.** `setContext` shallow-merges — **every untrusted
   plugin has direct write access to all shared state**, including state a
   different plugin or the host considers authoritative. Across a real trust
   boundary that is a smell.

This note proposes a model that fixes both, borrowing the **data-model and
authorization concepts** (not the runtime) from the distributed-ECS design in the
sibling `attr3` repository.

## The core idea: steal the blackboard, not the orchestrator

The ECS design has two separable halves:

- a **data-model + authorization layer** — entities, typed components, change
  detection, queries, per-component-type write policies, roles/claims; and
- an **execution layer** — a server that drives discrete-event *ticks*, invokes
  control loops on harmonic multi-rate clocks, breaks feedback cycles with delay
  edges, and supports deterministic replay.

The execution layer is built for robotics / simulation / control loops and is
**dead weight in a browser** — a UI shell is event-driven, has no `sim_time`, and
runs no control laws. But the **data-model layer** is an almost exact fit for
"shared, extensible, observable, access-controlled state across plugins."

So: adopt the blackboard, drop the tick engine.

## Model

### Entities and typed components

Shared state is an **entity/component store**, host-owned, living in the chrome:

- An **entity** is an addressable thing with a stable id (a map layer, a selection,
  a place, a plugin's annotation set).
- A **component** is a typed value attached to an entity. The pair
  `(entity, component-type)` is a **cell** — the smallest observable/writable unit.
- **Component-types are registered**, and can be registered *by plugins* — this is
  the extensibility mechanism. A map plugin registers a `MapLayer` component-type;
  any plugin can then query for `MapLayer` cells.

This replaces the single `SharedContext` interface with a small, uniform surface:
one store, one query mechanism, one subscription mechanism — regardless of how many
plugins contribute how many kinds of data.

### Write policies are the capability model

Every component-type declares **who may write its cells**. Three policies (lifted
directly from `attr3/docs/authorization.md`) cover the cases:

| Policy | Meaning | Frontend use |
|---|---|---|
| **creator-owns** (default) | only the plugin that created an entity may write its cells | plugin-contributed data: a plugin owns the map layers *it* adds |
| **host-owns** (named principal) | only the host may write | authoritative shared state: the canonical `Selection` |
| **role-claim** | whoever currently holds a named role may write | "the foreground app owns selection" — the write capability moves with focus |

The single-writer-per-cell rule is not a limitation to work around; **it is the
security property.** You do not let N untrusted plugins write one authoritative
cell. Contribution (creator-owns) is conflict-free by construction; shared
authoritative state is host-mediated.

### Shared *mutable* state: the request → reconcile (spec/status) pattern

The one genuinely hard case is state multiple parties want to change — the
selection. The answer is the Kubernetes **spec/status** split (control-systems:
the *setpoint* edge):

```
                      plugin A ──writes──▶ A.RequestedSelection   (creator-owns: A owns it)
                      plugin B ──writes──▶ B.RequestedSelection   (creator-owns: B owns it)
                                                   │
                                                   ▼
   host reconciler ──reads requests, applies policy, writes──▶ Selection  (host-owns)
                                                   │
   everyone ◀──────────────── subscribes ─────────┘
```

- Each plugin writes its **own** `RequestedSelection` cell (a cell it owns; no
  contention).
- A **host reconciler** reads the requests and writes the authoritative
  `Selection`, applying whatever policy the host wants: last-writer-wins, "only the
  foreground app may steal selection," "confirm before clearing," rate-limiting a
  noisy plugin, etc.
- Everyone subscribes to `Selection`.

This is exactly the "plugins *request* a change and the host decides" idea, made
first-class. The host stays the trust anchor; plugins express **intent**, the host
grants **effect**. It strictly improves on today's unmediated `setContext`.

For the common "the foreground app drives selection" rule, the **role-claim**
variant is even cleaner: a single `selection-owner` role, claimed by the foreground
app, transfers as focus moves; at most one claimant at a time. The reconciler
collapses to "the current claimant's request *is* the selection."

### Observation: per-component / per-query subscriptions with change detection

Generalise `subscribeContext` from "the whole bag changed" to:

- `subscribe(entity, component-type)` — one cell.
- `subscribe(query)` — a live set (all `MapLayer`s; all layers where `visible=true`).

Notifications are driven by **change detection**: a write whose new value equals the
old value is a no-op and notifies no one (the ECS's bytewise-coalescing rule). This
is the right default for observable UI state — you only react to real changes.

## API sketch (adapted to `@quilted/threads`)

The store lives in the host and is exposed on `HostThread`. Illustrative — not
final:

```ts
// ---- schema (plugins extend the model) ----
type Primitive = 'string' | 'number' | 'boolean' | 'json' | 'ref';
type WritePolicy =
  | { kind: 'creator-owns' }          // default
  | { kind: 'host-owns' }
  | { kind: 'role', role: string };   // foreground-owns-selection, etc.

interface ComponentTypeDef {
  name: string;                       // 'MapLayer', 'Selection', 'RequestedSelection'
  type: Primitive;
  writePolicy: WritePolicy;
}

interface SharedStore {
  // extensibility: a plugin contributes a new kind of shared data
  registerComponentType(def: ComponentTypeDef): Promise<void>;

  // data
  createEntity(externalId?: string): Promise<EntityId>;   // creator recorded = this plugin
  write(entity: EntityId, type: string, value: unknown): Promise<void>; // authz-checked
  read(entity: EntityId, type: string): Promise<unknown | undefined>;

  // discovery / observation
  query(q: Query): Promise<Array<{ entity: EntityId; value: unknown }>>;
  subscribe(q: Query, onChange: (delta: Delta) => void): Promise<() => void>;

  // roles (foreground-owns-selection)
  claimRole(role: string): Promise<boolean>;   // at-most-one-claimant; returns success
  releaseRole(role: string): Promise<void>;
}
```

The **host implements `write` as the authorization gate**: it knows the calling
plugin's identity (the thread it arrived on), looks up the component-type's write
policy, and admits or rejects. Plugins never touch each other's cells; the host is
mechanically in the path.

## What we deliberately leave behind

From the ECS design, we take the data model and authorization vocabulary and drop:

- **Ticks / `sim_time` / harmonic multi-rate clocks** — UI is event-driven.
- **`edge_delay` / feedback-cycle breaking** — no control loops.
- **Deterministic replay / time-travel** — nice for debugging, not core.
- **Namespace-as-isolated-store** — we *want* sharing; everything lives in one
  store and isolation is by write/read policy, not by store boundary.
- **The gRPC/Rust kernel** — this is a TS/postMessage broker; we port *concepts*.

## Reads, and the read-policy gap

The ECS has write policies but **no read policies yet** (an open question in
`attr3/docs/authorization.md`). For untrusted plugins, read scoping matters: a
plugin arguably should not observe *all* shared state. This is unspecified in the
source design and must be designed here — minimally, a per-component-type read
policy mirroring the write policy (public / host-only / role-scoped), enforced by
the host on `read`/`query`/`subscribe` just as write policy is enforced on `write`.

## The backend question (client-side vs. server-mediated)

Treat mechanism and authority as separate axes:

- **Ephemeral UI/workspace state** (selection, hover, visible layers, contributed
  toolbar sections) → **client-side host-mediated store** is right. The trust
  anchor already exists (the host owns the top-level origin; iframes are sandboxed
  cross-origin). Round-tripping every selection change to a server is bad UX and
  unnecessary *provided the host mediates writes*. No backend needed for the
  mechanics.
- **Authoritative / cross-user / sensitive data** → belongs behind a **backend**
  with real authz; plugins subscribe through it.

End state is a **hybrid**: the client-side blackboard above for ephemeral shared
state, plus a backend for authoritative data. The same authorization vocabulary
(principals, write policies, roles, read policies) describes both layers. If that
backend ever gets built, note that a *server* brokering shared, authorized,
observable state across many clients is much closer to the ECS's home turf than a
browser shell is — the data-model + authz layer would transfer to it directly.

## Migration from today's `SharedContext`

`selectedPlace` becomes:

- a `Selection` component-type (**host-owns**) on a singleton "workspace" entity;
- per-plugin `RequestedSelection` cells (**creator-owns**), or a `selection-owner`
  **role** claimed by the foreground app;
- a host **reconciler** mapping requests → `Selection`;
- `subscribeContext` → `subscribe({ component: 'Selection' })`.

The map (hub) writes `RequestedSelection` / claims the role; the Places panel
subscribes to `Selection` and can itself request a clear. Behaviour is unchanged;
the difference is that the host now *mediates* every write instead of letting any
plugin shallow-merge the shared bag — and any plugin can now contribute *new*
shared component-types (layers, annotations) that others discover by query.

## Open questions

- **Read policies** — the source design defers them; we need at least a
  public/host-only/role-scoped read policy for untrusted plugins.
- **Persistence / URL round-trip** — today the context is encoded in the host URL.
  The store needs a serialize/restore path that preserves the same
  deep-link-a-workspace property.
- **Reconciler expressiveness** — is a single host reconciler per shared cell
  enough, or do we want pluggable host-registered policies (last-writer-wins vs.
  priority vs. confirm)?
- **Standalone degradation** — a plugin running standalone has no host store; the
  `Platform` abstraction (`plugin-example/src/platform.tsx`) should expose the
  store as an optional capability that degrades to a local in-plugin store, exactly
  as `switchApp`/`listApps` degrade today.
