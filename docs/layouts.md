# Layouts: slot grids, predefined views, and the road to an app builder

Status: prototype. The model (views, blocks, wiring, CEL, validation) is the
shared package `packages/layout-model`, used by both the host and the layout
service. The host UI is in `packages/host/src` (`useLayouts.ts`,
`LayoutStage.tsx`, `instances.ts`, `instanceFeed.ts`, `commands.ts`,
`layoutClient.ts`). The service is `packages/layout-service`. Tests are in
`tests/layout.spec.ts`, `tests/blocks.spec.ts`, `tests/wiring.spec.ts`,
`tests/expressions.spec.ts`, `tests/actions.spec.ts` and
`tests/layout-service.spec.ts`.

## Why slots and not windows

Free-floating windows get you overlap, z-order fights, off-screen panels, and
every user's screen ending up different. The motivating cases need something
more constrained:

- **Cockpit displays** (e.g. the F-35's panoramic display, split into "portals").
  There are a fixed number of regions. The pilot picks what each one shows, and
  can temporarily enlarge one over its neighbours. Formats are predefined and
  don't get dragged around mid-flight.
- **Squarespace-style editors.** An author arranges sections on a grid. Readers
  (here, operators) use the result and maybe tweak it.

So the model is a **grid of cells carved into non-overlapping rectangular slots**.
Each slot shows at most one **block**, which is a configured, running instance of
an app. A named, saved grid is a **view**.

## Model (`layout.ts`, pure)

```ts
interface Slot   { id; col; row; colSpan; rowSpan; blockId: string | null }
interface Block  { id; appId; label?; settings?: BlockSettings }
interface LayoutView { id; name; cols; rows; slots: Slot[] }
interface Enlargement { slotId; rect }   // transient, run-time only
```

Blocks live in a registry shared by every view, so a block (say, the main map)
keeps its state when you switch views. Every app has an implicit **default
block** whose id is the app id. Apps mode shows these, and a view that just
names `world-map` gets the default. More instances of the same app are explicit
registry entries with ids like `world-map~2`.

Invariants: slots stay inside the grid and never overlap (`canPlace`). Every
edit operation (`placeSlot`, `addSlot`, `removeSlot`, `resizeGrid`) returns the
view unchanged if the result would break one.

## Two tiers of change

| | Who | Changes | Persistence |
|---|---|---|---|
| **Edit mode** ("✎ Edit layouts") | admin/author | grid size, slot geometry (drag to move, corner handle to resize, `+` on an empty cell to add, ✕ to remove), which block each slot shows, block names and settings (⚙), create/duplicate/delete/rename views | saved views + block registry (the layout service, per workspace and role; localStorage if the service is unreachable) |
| **User mode** | operator | switch view (drop-down); change a slot's block (per-slot drop-down: pick an existing block, which **swaps** if it's shown elsewhere, or "+ New <app>" for another instance); enlarge a slot one cell at a time (⋯ → Expand ◀▶▲▼) or maximize it (⛶, or double-click the header) | ad-hoc copy per view, discarded by "Reset view". Enlargement is cleared when the view changes. A block created here is added to the registry, but only the slot assignment is ad hoc |

When a slot is enlarged, the slots it overlaps are **covered**. Their apps stay
alive but hidden, and come back on restore.

## How it fits the plugin host

The existing host keeps every activated app mounted and positions it purely by
class. It never reparents an iframe, because moving an iframe in the DOM reloads
it. Layouts keep that rule by splitting the stage into two layers that share one
CSS grid template:

1. **Content layer.** The same kept-alive app cards as apps mode, placed with an
   inline `grid-area`. Moving, swapping, enlarging, or switching views only
   changes `grid-area` or `display`. Iframes, threads, and plugin state survive,
   and the e2e tests assert this.
2. **Slot layer.** A host-owned overlay keyed by *slot*, not app. It draws each
   slot's frame and header (app picker, enlarge menu) and, in edit mode, the
   drag/resize boxes. It is `pointer-events: none` except for its controls, so
   the plugins underneath stay interactive.

Everything else still applies. The ⌘K palette spans every visible slot's
commands, plugin toolbar contributions are active for visible apps, and the
shared-context broker composes apps across slots (select a city in the map slot
and the Places slot follows). The URL carries `?mode=layout&view=<id>`.

### Instances and settings

The host keys everything per instance, not per plugin: the iframe `title`, the
thread, the command registry, and the kept-alive list. An instance's id is its
block id. Instances render in first-mounted order, which is append-only, so
adding one never moves an existing iframe in the DOM. When two instances of the
same app are visible, the palette labels each command with its instance, e.g.
"Overview map · Pan the map to this city".

A plugin declares its settings in `ff-plugin.json#settings`:

```json
"settings": {
  "followSelection": {"type": "boolean", "label": "Follow the shared selection", "default": true},
  "flyZoom": {"type": "number", "label": "Zoom when flying to a city", "default": 9, "min": 1, "max": 16}
}
```

The supported types are `string`, `number`, `boolean` and `select`. The registry
passes the schema through untouched. The host renders a form for it (⚙ on a slot
in edit mode) and resolves each block's values over the defaults
(`resolveSettings` in `@ff/protocol`). Plugins read the resolved settings over
the thread with `getSettings()` and `subscribeSettings()`, and `getInstance()`
tells a plugin which block it is. In React, the SDK hook
`useHostSettings(host, defaults)` (`@ff/plugin-sdk-react/settings`) wraps this
and falls back to `defaults` when the plugin runs standalone. Setting changes in
edit mode reach the running plugin immediately without a reload. They are saved
with the view, and Cancel reverts them.

The "Two maps" default view shows this. It has an overview map that ignores the
shared selection, a detail map without city buttons that follows the selection
at a higher zoom, and Places. Pick a city on the overview and both of the others
update.

## Wiring blocks together

The shared context is one global bag that every app reads and writes. That's
fine for a map plus a detail panel, but an app builder needs the author to say
*which* block feeds *which*. So blocks declare typed **ports** in their manifest:

```json
"inputs":  {"viewport":  {"type": "bbox",  "label": "Filter to area"}},
"outputs": {"selection": {"type": "place", "label": "Picked city"},
            "range":     {"type": "range", "label": "Brushed population range"}}
```

A view holds **bindings** from one block's output to another block's input.
Wiring belongs to the view, not the block, so the same block can be wired
differently in different views:

```ts
interface Binding { blockId; input; from: {blockId; output} }
```

At run time:

- A plugin publishes with `host.publish(output, value)`. The host keeps each
  instance's latest output values.
- The host resolves each instance's inputs from the active view's bindings and
  pushes them when they change (`getInputs()` / `subscribeInputs()`; in React,
  `useHostInputs(host)`). Only wired inputs appear as keys, with `null` until
  the source publishes. A plugin can therefore tell "not connected" (fall back
  to its own behaviour) from "connected, nothing yet". Wiring applies only in
  layout mode; apps mode has none.
- Plugins never learn who is upstream or downstream. The host is the only
  router, so plugins stay isolated from each other.
- Port types are names (`place`, `bbox`, `range`, …) with shapes agreed in
  `@ff/protocol`. The host treats values as opaque JSON and only uses the type
  name to decide which outputs may feed which inputs.

In edit mode, the block panel (⚙) lists each input with a drop-down of
type-compatible outputs from the other blocks in the view, and lists the
block's outputs. Each slot box summarises its wiring (`⇠ focus ← Histogram.selection`).
The same panel has **Delete block** for extra instances; it is refused while
another saved view still uses the block.

A wired input takes precedence over the shared context. For example, the map's
`focus` input replaces "follow the shared selection", and Places' `place` input
replaces the shared selected place.

The **"Explorer (wired)"** default view shows the flow:

- The overview map's `viewport` feeds the histogram, which counts only cities
  in that area.
- Brushing the histogram narrows its city list, and it publishes the range.
- Picking a city publishes the histogram's `selection`, which feeds both the
  detail map's `focus` and Places' `place`.

**Subscribe replay.** A plugin reads, then subscribes, in two separate thread
round trips, so an update landing in between would be lost. The host therefore
sends the current value as soon as a plugin subscribes. This applies to
settings, inputs and the shared context.

## Derived expressions (CEL)

An input can be bound to an **expression** over block outputs instead of a
single output. Expressions are written in [CEL](https://cel.dev), the Common
Expression Language, and evaluated by
[`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js):

```
bboxAround(histogram.selection, 1500)              // a computed viewport
nearby.?selection.orValue(histogram.selection)     // first available pick
has(overview.selection) ? overview.selection : detail.selection
```

**Why CEL rather than a custom language:**

- It's designed for exactly this: side-effect free, non-Turing-complete,
  guaranteed to terminate, and fast.
- It's statically typed, which suits typed ports.
- It's widely used for user-authored rules (Kubernetes, Envoy, Firebase).
- It has implementations in Go, Java and C++, so a server could validate or
  evaluate the same bindings later.

**Why this implementation:** `@marcbachmann/cel-js` has no dependencies and
supports custom types from plain field schemas, typed custom functions,
optional chaining and static `check()`. The alternative, `@bufbuild/cel`,
models custom types as protobuf messages and pulls in protobuf and RE2. The
package claims "most of the CEL spec", not full conformance.

**How it maps:**

- **Blocks are variables.** Each block has a short CEL **name**: `overview`,
  `detail`, `nearby`, and for default blocks the app id made identifier-safe
  (`world_map`, `histogram`). The block panel shows it. A block's fields are
  its declared outputs.
- **Port types map to CEL types.** `place` → `Place`, `bbox` → `BBox`,
  `range` → `Range`, `number` → `double`, `string`, `boolean` → `bool`, and
  anything else → `dyn`. `Place`, `BBox` and `Range` are registered CEL types
  with typed fields, so `histogram.selection.latitude` type-checks as a
  `double`.
- **Custom functions:** `bboxAround`, `distanceKm`, `intersect`, `union`,
  `center`, `place`, `bbox`, `range` and `inRange`. Distance and number
  arguments have `int` overloads, so `1500` works as well as `1500.0`.
  Otherwise CEL's numeric rules are strict (`double - int` is a type error).
- **Unpublished outputs are absent, not null.** Use `has(x.out)` or optional
  chaining `x.?out.orValue(…)`. Any evaluation error, such as reading an absent
  output, makes the input `null`, which gives "not available yet" behaviour
  without special cases.
- **Results come back as plain JSON.** `bigint` becomes a number, and CEL
  values become plain objects, so they cross the iframe boundary as data.
- **Bindings record their language.** A binding is stored as
  `{expr, lang: 'cel'}`, so the format can change later.

**Editor:** each input's drop-down has "ƒ Expression (CEL)…", which opens a
text box with:

- live parse and type errors, including a result type that doesn't match the
  input (e.g. "Returns Place, but this input expects BBox");
- the inferred type;
- clickable `name.output` references to other blocks' outputs;
- a list of the custom functions and the main CEL idioms.

Switching from a direct source seeds the expression with the equivalent
reference.

The **"Nearby (derived)"** default view shows this. A second histogram
instance's viewport is `bboxAround(histogram.selection, 1500)`, so it lists the
cities within 1,500 km of whatever you pick in the first. Places shows
`nearby.?selection.orValue(histogram.selection)`.

## Layout service: roles, workspaces, server-side validation

Saved views and blocks are served by `@ff/layout-service` (:5181, Hono,
configured by `layout-service.config.yaml`):

| Endpoint | Who | What |
|---|---|---|
| `GET /v1/roles` | anyone | The roles and which of them can edit |
| `GET /v1/layouts` | any role | That role's views plus the block registry. Editors see every view; other roles see views whose `roles` include them |
| `PUT /v1/layouts/views/:id` | editors | Save a view plus the blocks the edit changed or deleted, **after conflict and validation checks**: `409` if someone else changed them first, `422` with errors if invalid |
| `DELETE /v1/layouts/views/:id?rev=`, `POST /v1/layouts/reset` | editors | Delete a view (not the last one; `409` if `rev` is stale), or reseed the defaults |
| `POST /v1/validate` | anyone | Validate without saving |

**Roles.** Each view has a `roles` list, and editor roles see every view. The
defaults' roles come from config (`seedViewRoles`), e.g. the cockpit-style
views for `pilot` and the analysis views for `analyst`. In edit mode, the "Visible
to" checkboxes set a view's roles.

**Workspaces.** Layouts are stored per workspace (tenant), persisted as one JSON
file each under `.data/`, or in memory with `FF_LAYOUT_EPHEMERAL=1`. A new
workspace is seeded from the model's defaults. The e2e tests give each test its
own workspace, so tests running in parallel don't see each other's saves.

**Identity is a prototype.** The host sends the chosen role and workspace as
`X-FF-Role` / `X-FF-Workspace` headers, and nothing authenticates them. A real
deployment would derive both from an authenticated session (e.g. OIDC claims)
and enforce them in the service. The service is already the point of
enforcement: editing is refused (`403`) for roles without `canEdit`, whatever
the UI shows.

**Server-side validation** runs `validateLayout` from `@ff/layout-model`, the
same code the host uses:

- grid bounds, slot overlaps and duplicate slot ids;
- unknown blocks or apps, and invalid or clashing expression names;
- for every binding: that the input exists, that a direct source's output
  exists and has a compatible type, and that a CEL expression parses and
  type-checks to the input's type.

The plugins' typed ports come from the plugin registry's discovery API. A
rejected save leaves the editor open with the server's errors listed.

**Concurrent edits (optimistic concurrency).** Every view and every block
carries a server-managed `rev`, which is bumped on each save. A save sends:

- the view with the `rev` it was loaded at;
- only the blocks the edit changed or deleted, each with its base `rev`
  (`blockChanges` in the model). A block with no `rev` was never saved, so it's
  always sent.

The service answers `409` if any of *those* entities has moved on, and includes
the current state in the response. Revisions are per entity, not per
workspace, so two editors only conflict when they touch the same view or the
same block. Resetting to defaults continues the revision numbers, so old
clients still conflict.

In the editor, a conflict shows what changed, with two options:

- **Reload latest** discards my edit.
- **Overwrite theirs** re-sends *my* changes rebased onto the current
  revisions. Only what this edit changed is overwritten; blocks someone else
  added or changed otherwise are kept.

**Fallback.** If the service can't be reached, the host shows **"○ Local only"**
and uses this browser's localStorage, which was the only mode before the
service existed. The shared model is the same either way. In local mode there
are no roles, and ad-hoc per-user changes aren't stored on the server in
either mode.

## Action buttons

The `actions` plugin (`packages/plugin-actions`) is a block of buttons that the
**layout author** defines, not the plugin. Its `buttons` input is usually bound
to a CEL list:

```
[
  {"label": "Tokyo", "value": place("Tokyo", 35.69, 139.69)},
  {"label": "Fly the detail map to Sydney", "command": command("detail", "map.fly.sydney")}
]
```

Pressing a button does one or both of these:

- **Publish its `value`** on the `pressed` output, and its label on
  `pressedLabel`. `pressed` has type `any`, so it can feed an input of any type
  (the editor offers `any` outputs to every input). When it enters CEL, the
  host converts a value of a known shape (place, bbox, range, command) to its
  CEL type, so `bboxAround(actions.pressed, 1500)` works.
- **Run its `command`**, which references another block's ⌘K command by the
  block's expression name. The plugin asks the host with
  `host.runCommand(ref)`.

**Authority comes from the wiring.** Plugins are untrusted, so the host runs a
command only if that exact `{block, command}` reference appears in the calling
block's current inputs (`inputsAuthorize` in `commands.ts`). Those inputs were
written by the layout author, so an action block can only trigger what it was
explicitly given. A request it wasn't given is refused with a toast, and so is
a reference to a block or command that isn't available.

While editing a `buttons` input, the CEL editor offers the commands registered
by the other blocks in the view as ready-made `command("name", "id")` chips.

The **"Quick actions"** default view shows this:

- Place buttons drive the detail map (`focus` ← `actions.pressed`), a nearby
  histogram (`bboxAround(actions.pressed, 1500)`) and Places.
- The last button runs the detail map's own "fly to Sydney" command.

## Towards an "app builder"

An app builder is the same slot model with a palette of **blocks** (map,
histogram/selection, action buttons, …) and, later, **logic** that wires them
together.

Done:

1. **Multiple instances of one block.** A slot references a block, and the host
   keys everything by instance (see "Instances and settings" above).
2. **Per-instance configuration.** Plugins declare a settings schema, the editor
   renders a form for it, and plugins receive the values live.
3. **Typed wiring.** Blocks declare inputs and outputs, views bind them, and the
   host routes values (see "Wiring blocks together" above).
4. **Derived expressions.** A binding can be a CEL expression over block
   outputs (see "Derived expressions (CEL)" above).
5. **Action blocks.** Author-defined buttons that publish values and run other
   blocks' commands, with authority granted through wiring (see "Action
   buttons" above).

Still to do:

6. **Nested / responsive grids** (optional). A slot could hold a sub-grid, and
   views could declare breakpoints. Leave both out until a use case needs them.

## Known gaps

- Roles and workspaces are unauthenticated headers (see "Layout service"
  above). Real identity is the main thing between this and production use.
- Per-user ad-hoc changes (a swapped slot, a block created in user mode) live
  only in the page. They aren't saved per user on the server.
- Conflicts are resolved per entity (keep mine or take theirs). There's no
  field-level merge, and no live notification that someone else is editing.
- Ad-hoc slot changes aren't encoded in the URL. Only the view id is.
- Adding a slot is click-per-cell then resize. There's no rubber-band draw, and
  no keyboard-accessible move/resize yet (the pickers and menus are keyboard
  accessible).
- A block can occupy only one slot per view at a time. Show the same app twice
  by creating a second block.
- Unused blocks aren't garbage-collected automatically. They can be deleted by
  hand from the block panel.
- Port types are just names. Nothing validates that a published value matches
  its declared type.
- Wiring has no cycle detection. A cycle would only loop if plugins republish
  on every input change, and none of the examples do.
- The editor offers only blocks placed in the current view as input sources.
  Expressions can reference any known block by name.
- Block names are assigned once and can't be renamed in the UI, because
  expressions refer to them. Renaming would need to rewrite those expressions,
  for example via the AST.
- Deleting a block removes direct wires from it. An expression that mentions it
  is kept and shows an "Unknown variable" error until it's fixed.
- Commands are fire-and-forget: they take no arguments, and a button can't
  pass its value to the command it runs.
- Expressions are evaluated on the main thread, on every render that resolves
  inputs (parsed expressions are cached). A worker would only matter for heavy
  expressions.
- The settings schema is deliberately tiny, with no validation beyond the input
  types. It should map onto JSON Schema if it grows.
