# Layouts: slot grids, predefined views, and the road to an app builder

Status: prototype implemented in the host (`packages/host/src/layout.ts`,
`useLayouts.ts`, `LayoutStage.tsx`, `instances.ts`); tests in
`tests/layout.spec.ts` and `tests/blocks.spec.ts`.

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
| **Edit mode** ("✎ Edit layouts") | admin/author | grid size, slot geometry (drag to move, corner handle to resize, `+` on an empty cell to add, ✕ to remove), which block each slot shows, block names and settings (⚙), create/duplicate/delete/rename views | saved views + block registry (localStorage in the prototype; a backend per role/mission in production) |
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

## Towards an "app builder"

An app builder is the same slot model with a palette of **blocks** (map,
histogram/selection, action buttons, …) and, later, **logic** that wires them
together.

Done:

1. **Multiple instances of one block.** A slot references a block, and the host
   keys everything by instance (see "Instances and settings" above).
2. **Per-instance configuration.** Plugins declare a settings schema, the editor
   renders a form for it, and plugins receive the values live.

Still to do:

3. **Wiring / derived expressions.** Generalise the shared context from one global
   bag into **named, typed channels** that blocks declare as inputs and outputs
   (`map.outputs.selection`, `histogram.inputs.filter`). A view then holds a small
   dataflow graph:
   `histogram.filter = where(dataset, field in map.selection.bbox)`. Evaluate the
   graph in the host (or a worker; see `shared-datamodel.md`). Plugins only see
   their resolved inputs and publish outputs, so the host stays the broker and
   plugins stay isolated. Expressions should be a small, sandboxed, pure language
   (a JSON-logic-style AST or a restricted expression parser), not arbitrary JS.
4. **Action blocks.** Buttons that invoke another block's exported command (the
   ⌘K command registry already proxies callbacks across iframes) or write to a
   channel.
5. **Nested / responsive grids** (optional). A slot could hold a sub-grid, and
   views could declare breakpoints. Leave both out until a use case needs them.

## Known gaps

- Views persist per browser (localStorage). There's no server, no roles, no
  sharing of saved views yet.
- Ad-hoc slot changes aren't encoded in the URL. Only the view id is.
- Adding a slot is click-per-cell then resize. There's no rubber-band draw, and
  no keyboard-accessible move/resize yet (the pickers and menus are keyboard
  accessible).
- A block can occupy only one slot per view at a time. Show the same app twice
  by creating a second block.
- Unused blocks are never garbage-collected from the registry, and there's no
  UI to delete a block.
- The settings schema is deliberately tiny, with no validation beyond the input
  types. It should map onto JSON Schema if it grows.
