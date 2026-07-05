# A shared, extensible datamodel for federated plugins

**Status:** design sketch / RFC. No code yet.

> Revision: this note originally proposed *porting concepts* from the `attr3` ECS
> into a hand-written TS broker and dropping the execution engine. Since then attr3
> has grown the exact pieces this use case needs — **read policies**, a **live-query
> `Subscribe` stream**, and **event-driven quiescence** — and the recommendation has
> firmed up: **compile attr3's engine (`kernel-core`) to WebAssembly and run it in a
> worker**, exposing it over postMessage instead of gRPC. We keep *both* of attr3's
> client surfaces (registered reducer-loops **and** subscribe/transact), because they
> serve different jobs.

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

And a third that only shows up once you have derived state: with `setContext`, when
one cell is *computed from* another (a `Selection` derived from per-plugin
`RequestedSelection`s), **the derivation is invisible** — some effect somewhere keeps
two cells correlated, and nothing in the system records that relationship. That is
the `useEffect`-mutates-shared-state anti-pattern; see *Two client modes* below.

## The core idea: run attr3's engine in a worker, over postMessage

The ECS design has two separable halves:

- a **data-model + authorization layer** — entities, typed components, change
  detection, queries, per-component-type **write *and* read policies**, roles/claims,
  and a live-query subscription stream; and
- an **execution layer** — a scheduler that runs **control loops** (pure
  `data-in → data-out` functions, i.e. reducers) on a change-propagation frontier,
  with deterministic replay.

The earlier version of this note discarded the execution layer as "dead weight in a
browser." That was wrong for the same reason Redux exists: the execution layer is
what makes a derivation **declared, observable, and reproducible** instead of a hidden
side effect. We keep it. What we actually replace is only the **transport/runtime
skin** — gRPC, the native SQLite persister, and the protobuf-descriptor loop
registration — none of which is load-bearing for the model.

So the plan is: **carve attr3's engine into a `kernel-core` library, compile it to
`wasm32-unknown-unknown`, and host it in a worker.** The engine's dependency
direction already makes this clean — the store/query/subscription/transaction
modules import nothing from the gRPC/scheduler-transport half, and the scheduler
itself is transport-agnostic (it drives loops through a `LoopTicker` trait, of which
gRPC is merely one impl). See *Worker architecture* below.

## Model

### Entities and typed components

Shared state is an **entity/component store**, host-owned, living in the worker:

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

Every component-type declares **who may write its cells**. Three policies (shipped in
`attr3/docs/authorization.md`) cover the cases:

| Policy | Meaning | Frontend use |
|---|---|---|
| **creator-owns** (`WritePolicy_EntityCreator`, default) | only the plugin that created an entity may write its cells | plugin-contributed data: a plugin owns the map layers *it* adds |
| **host-owns** (`WritePolicy_Principal`) | only the named principal (the host) may write | authoritative shared state: the canonical `Selection` |
| **role-claim** (`WritePolicy_Role`) | whoever currently holds a named role may write | "the foreground app owns selection" — the write capability moves with focus |

The single-writer-per-cell rule is not a limitation to work around; **it is the
security property.** You do not let N untrusted plugins write one authoritative
cell. Contribution (creator-owns) is conflict-free by construction; shared
authoritative state is host-mediated (below).

### Read policies (now built in attr3)

Read scoping — which the earlier draft flagged as an unbuilt gap — is now
implemented, mirroring write policy: **default-public with restrictive variants**
(`ReadPolicy_Principal`, `ReadPolicy_Role`, `ReadPolicy_EntityCreator`). A
component-type with no read policy is readable by anyone in the store; a restrictive
one is not. Enforced on every read (`Query` and `Subscribe`) as a **projection
filter** (a protected cell the caller may not read is dropped from the result) and a
**selector gate** (a query that *filters on* a protected type is rejected, so values
can't be filter-probed). This is what makes the store safe for **untrusted** plugins:
a plugin can be given a store handle without being able to observe host-private or
sibling-private cells.

### Two client modes (the important part)

The worker exposes **both** of attr3's client surfaces, and the choice between them
is *not* stylistic — it's whether the reaction is a **pure derivation** or an
**effect**:

- **Registered reducer-loops** (server-initiates). A loop is a pure
  `(declared inputs) → (declared outputs)` function — a reducer. It registers its
  reads/writes with the worker; the worker's scheduler invokes it (over the
  postMessage Tick tier) whenever an input changes. Because the loop *declares* its
  inputs and outputs, the derivation is a **first-class edge in the store** (loops are
  entities with components), so the whole derivation DAG is queryable, and the run is
  **reproducible** (pure function + recorded inputs → replayable). Use for **derived
  state**: `RequestedSelection → Selection`, aggregates, computed layers.
- **Subscribe + Transaction clients** (client-initiates). A client subscribes to a
  live query and imperatively reacts. Use for **effects** that can't be pure and
  shouldn't pretend to be: raise a toast, call a REST endpoint, imperatively fly the
  map, write to `localStorage`.

They compose: a reducer-loop writes `Selection`; a subscribe-client watches
`Selection` and flashes the map. The rule of thumb is Redux's: **derivations are
reducers, effects are subscribers.** The old `setContext` collapsed both into one
imperative channel, which is exactly why derived state was invisible.

### Shared *mutable* state: `RequestedSelection → Selection` as a reducer-loop

The one genuinely hard case is state multiple parties want to change — the
selection. The answer is the Kubernetes **spec/status** split, expressed as a
**registered reducer-loop** (not an ad-hoc effect):

```
   plugin A ──writes──▶ A.RequestedSelection   (creator-owns: A owns it)
   plugin B ──writes──▶ B.RequestedSelection   (creator-owns: B owns it)
                               │
                               ▼   (declared read)
        selection reducer-loop  ── applies policy ──▶  Selection   (host-owns; declared write)
                               │
   everyone ◀───── subscribes to Selection ─────┘
```

- Each plugin writes its **own** `RequestedSelection` cell (creator-owns; no
  contention).
- A **host-registered reducer-loop** declares "I read the `RequestedSelection`s, I
  write `Selection`," and computes `Selection` under whatever policy the host wants:
  last-writer-wins, "only the foreground app may steal selection," "confirm before
  clearing," rate-limiting a noisy plugin. Because it's declared, `Selection`'s
  dependence on `RequestedSelection` is **observable** (a devtool can render it) and
  **reproducible**.
- Everyone subscribes to `Selection`.

The loop body runs in the **host's** iframe (it's the host's policy), invoked by the
worker over postMessage. No feedback cycle exists (plugins subscribe to `Selection`
to *display* it, not to auto-write `RequestedSelection`); and if one ever formed,
change detection breaks it (a reducer that recomputes the same `Selection` writes a
no-op that emits no further event).

For the common "the foreground app drives selection" rule, the **role-claim** write
policy is even cleaner: a single `selection-owner` role, claimed by the foreground
app, transfers as focus moves; at most one claimant at a time. The reducer collapses
to "the current claimant's request *is* the selection" — or is dropped entirely, with
the foreground app writing `Selection` directly under the role.

### Observation: the live-query `Subscribe` stream

Generalise `subscribeContext` from "the whole bag changed" to attr3's built
`Subscribe(selector, projection) → stream`: an initial snapshot of the current
matches, then `added` / `removed` / `changed` deltas as commits land. Change
detection is bytewise-coalescing (a no-op write notifies no one), and delivery is
read-policy-filtered per subscriber. This is the exact mechanism behind both a
plugin's "watch the selection" and the host reducer-loop's "watch the requests."

## Worker architecture

A `SharedWorker` is **same-origin only**, which is exactly the boundary we want:

- The **host owns the worker** (host origin) and is its sole direct client.
- Each plugin gets a **`MessagePort`** the host hands out at load time, mapped to that
  plugin's **principal** (derived from its origin / registration). The worker enforces
  read/write policies against the port's principal; plugins never touch the store
  directly.
- Requests are the workload-agnostic RPCs, over postMessage instead of gRPC:
  `Query` (request/response), `Subscribe` (the worker streams events back on the port
  until unsubscribe/close — a `MessagePort` is already a bidirectional stream), and
  `Transaction` (request/ack).
- **Loops** register over the same channel and are invoked via a **`PostMessageTicker`**
  — the worker posts a `TickRequest` to the port holding the loop body and awaits the
  `TickResponse`. This is just another attr3 *calling tier* alongside gRPC; the
  scheduler already abstracts the transport behind a `LoopTicker` trait. Loop
  registration uses a **JS-native binding declaration** (reads/writes/rate as a plain
  object) rather than protobuf descriptors, which also drops the heaviest dependency
  from the wasm build.

**Quiescence makes this cheap.** attr3's per-namespace event-driven quiescence means
the worker does no work when nothing is changing — it sleeps until a message arrives,
runs only the loops downstream of the committed change (the change-propagation
frontier), and re-quiesces. For purely data-triggered frontend loops there is no timer
at all; the scheduler is "on message, run the frontier." So carrying the scheduler
into the worker does **not** mean burning the main thread.

**`kernel-core` split.** The extraction is `kernel` → `kernel-core` (the engine +
scheduler + frontier, wasm-compatible, persistence/credentials behind a trait) +
`kernel-server` (today's binary: tonic + native persistence) + `kernel-wasm` (the
worker: `PostMessageTicker` + transport + JS-native registration). What's dropped for
wasm is only the skin: `tonic`, native `rusqlite` (swap for IndexedDB if persistence
is wanted), and the protobuf-descriptor loop parsing.

## API sketch (adapted to `@quilted/threads`)

Illustrative — not final. Both client modes are present:

```ts
type Primitive = 'string' | 'number' | 'boolean' | 'json' | 'ref';
type WritePolicy =
  | { kind: 'creator-owns' } | { kind: 'host-owns' } | { kind: 'role'; role: string };
type ReadPolicy =
  | { kind: 'public' } | { kind: 'principal'; name: string }
  | { kind: 'role'; role: string } | { kind: 'creator-owns' };

interface SharedStore {
  // schema (plugins extend the model)
  registerComponentType(def: {
    name: string; type: Primitive; writePolicy: WritePolicy; readPolicy?: ReadPolicy;
  }): Promise<void>;

  // client-initiates: reads, writes, effects
  transaction(ops: WriteOp[]): Promise<void>;                 // authz-checked, atomic
  query(q: Query): Promise<Row[]>;                            // read-policy-filtered
  subscribe(q: Query, on: (e: SubscribeEvent) => void): Promise<() => void>;

  // server-initiates: pure derivations
  registerLoop(def: {
    reads: string[]; writes: string[];                       // declared dataflow
    body: (inputs: Row[]) => WriteOp[];                       // pure reducer
  }): Promise<() => void>;                                    // returns unregister

  // roles (foreground-owns-selection)
  claimRole(role: string): Promise<boolean>;
  releaseRole(role: string): Promise<void>;
}
```

The host wires each plugin's `MessagePort` to a principal, so `transaction` /
`query` / `subscribe` / `registerLoop` are all authorized against the caller with no
per-call identity plumbing.

## What we deliberately leave behind

From attr3 we keep the data model, the authorization model (read + write policies,
roles), **and** the reducer-loop execution model. We drop only:

- **The gRPC transport** (`tonic`) — replaced by postMessage / `MessagePort`.
- **Native persistence** (`rusqlite`) — the store is in-worker; add IndexedDB later if
  a durable/offline copy is wanted (see *Backend* + *Open questions*).
- **Protobuf-descriptor loop registration** (`prost-reflect`) — replaced by a
  JS-native binding declaration.
- **`sim_time` / harmonic multi-rate clocks / catch-up** — the UI has no simulated
  wall-clock; loops here are purely change-triggered.
- **Namespace-as-isolated-store as the *sharing* boundary** — we *want* sharing, so
  everything shared lives in one namespace and isolation is by read/write policy.
  (Namespaces are still useful as a *workspace* boundary — one per composed workspace.)

## The backend question (client-side vs. server-mediated)

Treat mechanism and authority as separate axes:

- **Ephemeral UI/workspace state** (selection, hover, visible layers, contributed
  toolbar sections) → the **in-worker store** is right. The trust anchor already
  exists (the host owns the top-level origin; iframes are sandboxed cross-origin).
  Round-tripping every selection change to a server is bad UX and unnecessary
  *provided the host mediates writes*.
- **Authoritative / cross-user / sensitive data** → belongs behind a **backend** with
  real authz; plugins subscribe through it.

End state is a **hybrid** — the in-worker blackboard for ephemeral shared state, a
backend for authoritative data — and because we're running the *same engine* in both
places, the split is uniform: the backend is literally `kernel-server` (the same
`kernel-core` with the gRPC/persistence skin), and the same read/write-policy
vocabulary describes both layers. A server brokering shared, authorized, observable
state across many clients is closer to attr3's home turf than a browser is, so that
half transfers directly.

## Migration from today's `SharedContext`

`selectedPlace` becomes:

- a `Selection` component-type (**host-owns**) on a singleton "workspace" entity;
- per-plugin `RequestedSelection` cells (**creator-owns**), or a `selection-owner`
  **role** claimed by the foreground app;
- a host-registered **selection reducer-loop** mapping requests → `Selection` (a
  declared, observable derivation — not a hidden effect);
- `subscribeContext` → `subscribe({ component: 'Selection' })`.

The map (hub) writes `RequestedSelection` / claims the role; the Places panel
subscribes to `Selection` and can itself request a clear. Behaviour is unchanged;
the difference is that the host now *mediates* every write, the request→selection
derivation is *first-class and inspectable*, and any plugin can contribute *new*
shared component-types (layers, annotations) that others discover by query.

## Open questions

- **Wire encoding** — keep protobuf (protobuf-es ↔ prost; good if a backend later
  shares the schema) or use plain JS objects via structured-clone (more idiomatic for
  a pure frontend, drops a serialization layer). Leaning JS objects for frontend-only.
- **Async loop invocation in wasm** — the scheduler must await a `TickResponse`
  postMessage; drive it on the browser event loop (`wasm-bindgen-futures`). Feasible,
  and mostly event-driven (no timer) thanks to quiescence.
- **Structured values** — a frontend naturally stores a JSON / JS object as an
  immutable cell value; a backend stores `bytes` (e.g. protobuf) with the schema
  declared as components on the component-type itself. A `json` primitive covers the
  frontend case; the protobuf-metadata-as-components mechanism is a backend concern,
  tangential here. Revisit if/when needed.
- **Persistence / URL round-trip** — today the context is encoded in the host URL. The
  store needs a serialize/restore path that preserves the deep-link-a-workspace
  property (IndexedDB for durability; URL for shareable snapshots).
- **Standalone degradation** — a plugin running standalone has no host worker; the
  `Platform` abstraction (`plugin-example/src/platform.tsx`) should expose the store as
  an optional capability that degrades to a local in-plugin store, exactly as
  `switchApp`/`listApps` degrade today.
