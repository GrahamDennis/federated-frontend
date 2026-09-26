import type {BlockSettings} from '@ff/protocol';

/**
 * The layout model: a fixed grid of cells, carved into rectangular **slots**,
 * each showing (at most) one **block** — a running instance of an app. Think cockpit displays rather than a windowing
 * system — slots snap to cells, never overlap, and the set of slots is authored
 * ahead of time (in edit mode) as a named **view**. At run time the user can make
 * ad-hoc changes within a view: swap which app a slot shows, or temporarily
 * enlarge a slot over its neighbours.
 *
 * Blocks live in a registry shared by every view, so the same block (say, the
 * main map) keeps its state as you switch views. Each app has an implicit
 * default block whose id is the app id; more instances of an app (a second map
 * with different settings) are explicit {@link Block} entries.
 *
 * Everything here is pure (no DOM, no Preact) so it's trivially testable.
 */

export interface Rect {
  /** 0-based column / row of the top-left cell. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface Slot extends Rect {
  id: string;
  /** The block shown in this slot, or null for an empty slot. */
  blockId: string | null;
}

/** A configured instance of an app. */
export interface Block {
  id: string;
  appId: string;
  /** Display name; defaults to the app's name. */
  label?: string;
  /** Values for the app's declared settings (merged over its defaults). */
  settings?: BlockSettings;
}

/** Explicit block entries, keyed by id. Default blocks (id = app id) are implicit. */
export type BlockRegistry = Record<string, Block>;

/** Look up a block, falling back to the implicit default block of an app. */
export function blockFor(
  blocks: BlockRegistry,
  id: string,
  appIds: readonly string[],
): Block | null {
  return blocks[id] ?? (appIds.includes(id) ? {id, appId: id} : null);
}

/** A fresh block id for another instance of `appId`. */
export function newBlockId(appId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 2;
  while (used.has(`${appId}~${n}`)) n++;
  return `${appId}~${n}`;
}

export interface LayoutView {
  id: string;
  name: string;
  cols: number;
  rows: number;
  slots: Slot[];
}

/** A temporary run-time enlargement of one slot (covers the slots under it). */
export interface Enlargement {
  slotId: string;
  rect: Rect;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

export const MAX_GRID = 8;

export const DEFAULT_BLOCKS: BlockRegistry = {
  'world-map~overview': {
    id: 'world-map~overview',
    appId: 'world-map',
    label: 'Overview map',
    settings: {title: 'Overview', followSelection: false, flyZoom: 4},
  },
  'world-map~detail': {
    id: 'world-map~detail',
    appId: 'world-map',
    label: 'Detail map',
    settings: {title: 'Detail', showCities: false, flyZoom: 12},
  },
};

export const DEFAULT_VIEWS: LayoutView[] = [
  {
    id: 'nav-detail',
    name: 'Map + detail',
    cols: 3,
    rows: 2,
    slots: [
      {id: 's1', col: 0, row: 0, colSpan: 2, rowSpan: 2, blockId: 'world-map'},
      {id: 's2', col: 2, row: 0, colSpan: 1, rowSpan: 1, blockId: 'places'},
      {id: 's3', col: 2, row: 1, colSpan: 1, rowSpan: 1, blockId: 'example-notes'},
    ],
  },
  {
    id: 'quad',
    name: 'Quad',
    cols: 2,
    rows: 2,
    slots: [
      {id: 's1', col: 0, row: 0, colSpan: 1, rowSpan: 1, blockId: 'world-map'},
      {id: 's2', col: 1, row: 0, colSpan: 1, rowSpan: 1, blockId: 'places'},
      {id: 's3', col: 0, row: 1, colSpan: 1, rowSpan: 1, blockId: 'example-notes'},
      {id: 's4', col: 1, row: 1, colSpan: 1, rowSpan: 1, blockId: null},
    ],
  },
  {
    // Cockpit-style: a row of equal "portals" the pilot fills and enlarges.
    id: 'portals',
    name: 'Portals (4-up)',
    cols: 4,
    rows: 1,
    slots: [
      {id: 's1', col: 0, row: 0, colSpan: 1, rowSpan: 1, blockId: 'world-map'},
      {id: 's2', col: 1, row: 0, colSpan: 1, rowSpan: 1, blockId: 'places'},
      {id: 's3', col: 2, row: 0, colSpan: 1, rowSpan: 1, blockId: 'example-notes'},
      {id: 's4', col: 3, row: 0, colSpan: 1, rowSpan: 1, blockId: null},
    ],
  },
  {
    // Two instances of the same plugin, configured differently: pick a city on
    // the overview and the detail map (which follows the selection) zooms in.
    id: 'two-maps',
    name: 'Two maps',
    cols: 3,
    rows: 2,
    slots: [
      {id: 's1', col: 0, row: 0, colSpan: 1, rowSpan: 1, blockId: 'world-map~overview'},
      {id: 's2', col: 1, row: 0, colSpan: 2, rowSpan: 2, blockId: 'world-map~detail'},
      {id: 's3', col: 0, row: 1, colSpan: 1, rowSpan: 1, blockId: 'places'},
    ],
  },
];

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan &&
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan
  );
}

export function inBounds(view: Pick<LayoutView, 'cols' | 'rows'>, r: Rect): boolean {
  return (
    r.col >= 0 &&
    r.row >= 0 &&
    r.colSpan >= 1 &&
    r.rowSpan >= 1 &&
    r.col + r.colSpan <= view.cols &&
    r.row + r.rowSpan <= view.rows
  );
}

/** Can `rect` be occupied (by slot `ignoreId`, if any) without overlapping another slot? */
export function canPlace(view: LayoutView, rect: Rect, ignoreId?: string): boolean {
  return (
    inBounds(view, rect) &&
    view.slots.every((s) => s.id === ignoreId || !rectsOverlap(s, rect))
  );
}

/** CSS `grid-area` for a rect. */
export function gridArea(r: Rect): string {
  return `${r.row + 1} / ${r.col + 1} / span ${r.rowSpan} / span ${r.colSpan}`;
}

export function rectOf(slot: Slot): Rect {
  return {col: slot.col, row: slot.row, colSpan: slot.colSpan, rowSpan: slot.rowSpan};
}

// ---- Edit-mode operations (return a new view, or the same view if invalid) ----

export function placeSlot(view: LayoutView, slotId: string, rect: Rect): LayoutView {
  if (!canPlace(view, rect, slotId)) return view;
  return {
    ...view,
    slots: view.slots.map((s) => (s.id === slotId ? {...s, ...rect} : s)),
  };
}

export function addSlot(view: LayoutView, rect: Rect, blockId: string | null = null): LayoutView {
  if (!canPlace(view, rect)) return view;
  const used = new Set(view.slots.map((s) => s.id));
  let n = view.slots.length + 1;
  while (used.has(`s${n}`)) n++;
  return {...view, slots: [...view.slots, {id: `s${n}`, ...rect, blockId}]};
}

export function removeSlot(view: LayoutView, slotId: string): LayoutView {
  return {...view, slots: view.slots.filter((s) => s.id !== slotId)};
}

/** Resize the grid, dropping slots that would no longer fit. */
export function resizeGrid(view: LayoutView, cols: number, rows: number): LayoutView {
  const c = clamp(cols, 1, MAX_GRID);
  const r = clamp(rows, 1, MAX_GRID);
  return {
    ...view,
    cols: c,
    rows: r,
    slots: view.slots.filter((s) => inBounds({cols: c, rows: r}, s)),
  };
}

/** Cells not covered by any slot (for "add a slot here" affordances). */
export function emptyCells(view: LayoutView): Rect[] {
  const cells: Rect[] = [];
  for (let row = 0; row < view.rows; row++) {
    for (let col = 0; col < view.cols; col++) {
      const cell = {col, row, colSpan: 1, rowSpan: 1};
      if (view.slots.every((s) => !rectsOverlap(s, cell))) cells.push(cell);
    }
  }
  return cells;
}

// ---- Run-time (user mode) operations ----

/**
 * Show block `blockId` in `slotId`. A block is a single kept-alive instance, so
 * it lives in at most one slot: if it's already shown elsewhere the two swap.
 * (To show the same *app* twice, create another block of it.)
 */
export function assignBlock(view: LayoutView, slotId: string, blockId: string | null): LayoutView {
  const target = view.slots.find((s) => s.id === slotId);
  if (!target) return view;
  const previous = target.blockId;
  return {
    ...view,
    slots: view.slots.map((s) => {
      if (s.id === slotId) return {...s, blockId};
      if (blockId !== null && s.blockId === blockId) return {...s, blockId: previous};
      return s;
    }),
  };
}

/** Grow a rect one cell in a direction (null if that would leave the grid). */
export function growRect(view: LayoutView, r: Rect, dir: Direction): Rect | null {
  const next = {...r};
  if (dir === 'left') {
    next.col -= 1;
    next.colSpan += 1;
  } else if (dir === 'right') {
    next.colSpan += 1;
  } else if (dir === 'up') {
    next.row -= 1;
    next.rowSpan += 1;
  } else {
    next.rowSpan += 1;
  }
  return inBounds(view, next) ? next : null;
}

export function fullRect(view: LayoutView): Rect {
  return {col: 0, row: 0, colSpan: view.cols, rowSpan: view.rows};
}

export function isFull(view: LayoutView, r: Rect): boolean {
  return r.col === 0 && r.row === 0 && r.colSpan === view.cols && r.rowSpan === view.rows;
}

export interface ResolvedSlot {
  slot: Slot;
  /** Where the slot is drawn right now (its own rect, or its enlargement). */
  rect: Rect;
  enlarged: boolean;
  /** Hidden under another slot's enlargement (its app stays alive). */
  covered: boolean;
}

/** Apply an enlargement: the enlarged slot grows; any slot it touches is covered. */
export function resolveSlots(view: LayoutView, enlargement: Enlargement | null): ResolvedSlot[] {
  const big = enlargement && view.slots.find((s) => s.id === enlargement.slotId);
  return view.slots.map((slot) => {
    if (big && slot.id === big.id) {
      return {slot, rect: enlargement!.rect, enlarged: true, covered: false};
    }
    return {
      slot,
      rect: rectOf(slot),
      enlarged: false,
      covered: Boolean(big && rectsOverlap(slot, enlargement!.rect)),
    };
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n) || lo));
}
