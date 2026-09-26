# Layouts: slot grids, predefined views, and the road to an app builder

Status: prototype implemented in the host (`packages/host/src/layout.ts`,
`useLayouts.ts`, `LayoutStage.tsx`); tests in `tests/layout.spec.ts`.

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
Each slot shows at most one app. A named, saved grid is a **view**.

## Model (`layout.ts`, pure)

```ts
interface Slot   { id; col; row; colSpan; rowSpan; appId: string | null }
interface LayoutView { id; name; cols; rows; slots: Slot[] }
interface Enlargement { slotId; rect }   // transient, run-time only
```

Invariants: slots stay inside the grid and never overlap (`canPlace`). Every
edit operation (`placeSlot`, `addSlot`, `removeSlot`, `resizeGrid`) returns the
view unchanged if the result would break one.

## Two tiers of change

| | Who | Changes | Persistence |
|---|---|---|---|
| **Edit mode** ("✎ Edit layouts") | admin/author | grid size, slot geometry (drag to move, corner handle to resize, `+` on an empty cell to add, ✕ to remove), default app per slot, create/duplicate/delete/rename views | saved views (localStorage in the prototype; a backend per role/mission in production) |
| **User mode** | operator | switch view (drop-down); change a slot's app (per-slot drop-down, which **swaps** if the app is already shown elsewhere); enlarge a slot one cell at a time (⋯ → Expand ◀▶▲▼) or maximize it (⛶, or double-click the header) | ad-hoc copy per view, discarded by "Reset view". Enlargement is cleared when the view changes |

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

## Towards an "app builder"

An app builder is the same slot model with a palette of **blocks** (map,
histogram/selection, action buttons, …) and, later, **logic** that wires them
together. What the prototype doesn't do yet, and how each piece would go:

1. **Multiple instances of one block.** This is the one real structural change.
   Today an app is a singleton keyed by plugin id: iframe `title`, per-plugin
   command registry, keep-alive list. A builder needs two maps or three
   histograms. Introduce an **instance id** (`slot.blockInstanceId`, mapping to
   `{pluginId, config}`) and key `PluginHost`, commands, and keep-alive by
   instance. The plugin receives its instance id and config over the handshake
   (e.g. `host.getInstance()`).
2. **Per-instance configuration.** Blocks declare a config schema in
   `ff-plugin.json` (e.g. which dataset or field a histogram shows). The editor
   renders a form for it in the slot's edit box. Config is saved with the view.
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
- An app can occupy only one slot at a time (see instances above).
