import {useRef, useState} from 'preact/hooks';
import type {SettingDescriptor, SettingValue} from '@ff/protocol';
import type {AppDescriptor} from './apps';
import {instanceFor, knownInstances, type Instance} from './instances';
import {
  MAX_GRID,
  addSlot,
  canPlace,
  emptyCells,
  gridArea,
  growRect,
  isFull,
  placeSlot,
  rectOf,
  removeSlot,
  resizeGrid,
  type Direction,
  type Rect,
  type ResolvedSlot,
} from './layout';
import type {Layouts} from './useLayouts';

/** Must match `--layout-gap` in styles.css (used to map pointer → cell). */
export const LAYOUT_GAP = 12;
/** Height of the host-drawn slot header the content layer leaves room for. */
export const SLOT_HEADER = 34;

export function gridTemplate(cols: number, rows: number) {
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };
}

/**
 * The bar above the stage: the user-facing view switcher, and (in edit mode) the
 * admin controls for authoring the view itself.
 */
export function LayoutBar({layouts}: {layouts: Layouts}) {
  const {view, editing} = layouts;

  if (!editing) {
    return (
      <div className="layout-bar">
        <label className="layout-field">
          View
          <select
            aria-label="Layout view"
            value={layouts.activeViewId}
            onChange={(e) => layouts.selectView(e.currentTarget.value)}
          >
            {layouts.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        {layouts.hasAdHocChanges && (
          <button className="btn" onClick={layouts.resetView}>
            Reset view
          </button>
        )}
        <span className="layout-bar-spacer" />
        <button className="btn" onClick={layouts.startEditing}>
          ✎ Edit layouts
        </button>
      </div>
    );
  }

  const setGrid = (cols: number, rows: number) =>
    layouts.updateDraft((d) => d && resizeGrid(d, cols, rows));

  return (
    <div className="layout-bar editing">
      <span className="layout-bar-mode">Editing</span>
      <label className="layout-field">
        Name
        <input
          aria-label="View name"
          value={view.name}
          onInput={(e) => {
            const name = e.currentTarget.value;
            layouts.updateDraft((d) => d && {...d, name});
          }}
        />
      </label>
      <label className="layout-field">
        Cols
        <input
          aria-label="Columns"
          type="number"
          min={1}
          max={MAX_GRID}
          value={view.cols}
          onInput={(e) => setGrid(Number(e.currentTarget.value), view.rows)}
        />
      </label>
      <label className="layout-field">
        Rows
        <input
          aria-label="Rows"
          type="number"
          min={1}
          max={MAX_GRID}
          value={view.rows}
          onInput={(e) => setGrid(view.cols, Number(e.currentTarget.value))}
        />
      </label>
      <button className="btn" onClick={() => layouts.newDraft()}>
        New
      </button>
      <button className="btn" onClick={() => layouts.newDraft(view)}>
        Duplicate
      </button>
      {!layouts.draftIsNew && layouts.views.length > 1 && (
        <button className="btn btn-critical" onClick={layouts.deleteView}>
          Delete view
        </button>
      )}
      <span className="layout-bar-spacer" />
      <button className="btn" onClick={layouts.resetToDefaults} title="Discard all saved views">
        Restore defaults
      </button>
      <button className="btn" onClick={layouts.cancelEditing}>
        Cancel
      </button>
      <button className="btn btn-primary" onClick={layouts.saveDraft}>
        Save view
      </button>
    </div>
  );
}

interface DragState {
  slotId: string;
  kind: 'move' | 'resize';
  start: {col: number; row: number};
  origin: Rect;
  rect: Rect;
  valid: boolean;
}

/**
 * The slot layer: a host-owned overlay sharing the content layer's grid. It draws
 * each slot's frame and header (the app picker + enlarge menu) in user mode, and
 * the drag/resize/add/remove affordances in edit mode.
 *
 * Keeping slot chrome here (keyed by slot) rather than inside the app card (keyed
 * by app) is what lets the app iframes underneath stay put: swapping or moving
 * content only changes their `grid-area`, never their place in the DOM.
 */
export function SlotLayer({
  layouts,
  apps,
}: {
  layouts: Layouts;
  apps: AppDescriptor[];
}) {
  const {view, resolved, editing} = layouts;
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menuSlotId, setMenuSlotId] = useState<string | null>(null);
  const [settingsBlockId, setSettingsBlockId] = useState<string | null>(null);
  const instance = (id: string | null) => (id ? instanceFor(layouts.blocks, id, apps) : null);
  const picker = (slotId: string, value: string | null, label: string) => (
    <BlockPicker
      layouts={layouts}
      apps={apps}
      slotId={slotId}
      value={value}
      label={label}
    />
  );
  const settingsFor = editing && settingsBlockId ? instance(settingsBlockId) : null;

  function cellAt(event: PointerEvent): {col: number; row: number} {
    const box = ref.current!.getBoundingClientRect();
    const cw = (box.width - LAYOUT_GAP * (view.cols - 1)) / view.cols;
    const ch = (box.height - LAYOUT_GAP * (view.rows - 1)) / view.rows;
    const col = Math.floor((event.clientX - box.left) / (cw + LAYOUT_GAP));
    const row = Math.floor((event.clientY - box.top) / (ch + LAYOUT_GAP));
    return {
      col: Math.max(0, Math.min(view.cols - 1, col)),
      row: Math.max(0, Math.min(view.rows - 1, row)),
    };
  }

  function beginDrag(event: PointerEvent, slotId: string, kind: DragState['kind']) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const slot = view.slots.find((s) => s.id === slotId)!;
    const origin = rectOf(slot);
    setDrag({slotId, kind, start: cellAt(event), origin, rect: origin, valid: true});
  }

  function moveDrag(event: PointerEvent) {
    if (!drag) return;
    const cell = cellAt(event);
    const {origin} = drag;
    const rect =
      drag.kind === 'move'
        ? {
            ...origin,
            col: Math.max(0, Math.min(view.cols - origin.colSpan, origin.col + cell.col - drag.start.col)),
            row: Math.max(0, Math.min(view.rows - origin.rowSpan, origin.row + cell.row - drag.start.row)),
          }
        : {
            ...origin,
            colSpan: Math.max(1, cell.col - origin.col + 1),
            rowSpan: Math.max(1, cell.row - origin.row + 1),
          };
    setDrag({...drag, rect, valid: canPlace(view, rect, drag.slotId)});
  }

  function endDrag() {
    if (!drag) return;
    const {slotId, rect} = drag;
    layouts.updateDraft((d) => d && placeSlot(d, slotId, rect));
    setDrag(null);
  }


  return (
    <div
      ref={ref}
      className={`slot-layer${editing ? ' editing' : ''}`}
      style={gridTemplate(view.cols, view.rows)}
    >
      {editing &&
        emptyCells(view).map((cell) => (
          <button
            key={`cell-${cell.col}-${cell.row}`}
            className="empty-cell"
            style={{gridArea: gridArea(cell)}}
            title="Add a slot here"
            aria-label={`Add slot at column ${cell.col + 1}, row ${cell.row + 1}`}
            onClick={() => layouts.updateDraft((d) => d && addSlot(d, cell))}
          >
            +
          </button>
        ))}

      {resolved.map((r) =>
        editing ? (
          <div
            key={r.slot.id}
            className={`slot slot-edit${drag?.slotId === r.slot.id ? ' dragging' : ''}`}
            data-slot={r.slot.id}
            style={{gridArea: gridArea(r.rect)}}
            onPointerDown={(e) => beginDrag(e, r.slot.id, 'move')}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={() => setDrag(null)}
          >
            <div className="slot-header" style={{height: SLOT_HEADER}}>
              <span className="slot-grip" aria-hidden>
                ⠿
              </span>
              {picker(r.slot.id, r.slot.blockId, `Block for slot ${r.slot.id}`)}
              {instance(r.slot.blockId)?.app.settings && (
                <button
                  className="slot-icon"
                  aria-label={`Settings for slot ${r.slot.id}`}
                  title="Block settings"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setSettingsBlockId(r.slot.blockId)}
                >
                  ⚙
                </button>
              )}
              <span className="slot-size">
                {r.slot.colSpan}×{r.slot.rowSpan}
              </span>
              <button
                className="slot-icon"
                aria-label={`Remove slot ${r.slot.id}`}
                title="Remove slot"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => layouts.updateDraft((d) => d && removeSlot(d, r.slot.id))}
              >
                ✕
              </button>
            </div>
            <div className="slot-edit-body">
              {instance(r.slot.blockId)?.label ?? 'Empty'}
              {r.slot.blockId && (
                <span className="slot-edit-id">{r.slot.blockId}</span>
              )}
            </div>
            <div
              className="slot-resize"
              aria-label={`Resize slot ${r.slot.id}`}
              title="Drag to resize"
              onPointerDown={(e) => beginDrag(e, r.slot.id, 'resize')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
            />
          </div>
        ) : (
          <SlotFrame
            key={r.slot.id}
            resolved={r}
            layouts={layouts}
            picker={picker(r.slot.id, r.slot.blockId, `Block in slot ${r.slot.id}`)}
            menuOpen={menuSlotId === r.slot.id}
            setMenuOpen={(open) => setMenuSlotId(open ? r.slot.id : null)}
          />
        ),
      )}

      {settingsFor && (
        <BlockSettingsPanel
          instance={settingsFor}
          layouts={layouts}
          onClose={() => setSettingsBlockId(null)}
        />
      )}

      {drag && (
        <div
          className={`slot-ghost${drag.valid ? '' : ' invalid'}`}
          style={{gridArea: gridArea(drag.rect)}}
        />
      )}
    </div>
  );
}

function SlotFrame({
  resolved: r,
  layouts,
  picker,
  menuOpen,
  setMenuOpen,
}: {
  resolved: ResolvedSlot;
  layouts: Layouts;
  picker: preact.ComponentChild;
  menuOpen: boolean;
  setMenuOpen(open: boolean): void;
}) {
  const {view} = layouts;
  const maximized = r.enlarged && isFull(view, r.rect);
  const expand = (dir: Direction) => {
    layouts.expandSlot(r.slot.id, dir);
    setMenuOpen(false);
  };
  const can = (dir: Direction) => growRect(view, r.rect, dir) !== null;

  return (
    <div
      className={`slot${r.enlarged ? ' enlarged' : ''}${menuOpen ? ' menu-open' : ''}`}
      data-slot={r.slot.id}
      hidden={r.covered}
      style={{gridArea: gridArea(r.rect)}}
    >
      <div
        className="slot-header"
        style={{height: SLOT_HEADER}}
        onDblClick={(e) => {
          if (e.target === e.currentTarget) layouts.toggleMaximize(r.slot.id);
        }}
      >
        {picker}
        <span className="slot-header-spacer" />
        {r.enlarged && (
          <button
            className="slot-icon"
            title="Restore size"
            aria-label={`Restore slot ${r.slot.id}`}
            onClick={layouts.restoreSlot}
          >
            ⤡
          </button>
        )}
        <button
          className="slot-icon"
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={`${maximized ? 'Restore' : 'Maximize'} slot ${r.slot.id}`}
          onClick={() => layouts.toggleMaximize(r.slot.id)}
        >
          {maximized ? '▣' : '⛶'}
        </button>
        <button
          className="slot-icon"
          title="Enlarge into a neighbouring slot"
          aria-label={`Enlarge slot ${r.slot.id}`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="slot-menu" role="menu">
            <button role="menuitem" disabled={!can('left')} onClick={() => expand('left')}>
              ◀ Expand left
            </button>
            <button role="menuitem" disabled={!can('right')} onClick={() => expand('right')}>
              ▶ Expand right
            </button>
            <button role="menuitem" disabled={!can('up')} onClick={() => expand('up')}>
              ▲ Expand up
            </button>
            <button role="menuitem" disabled={!can('down')} onClick={() => expand('down')}>
              ▼ Expand down
            </button>
          </div>
        )}
      </div>
      {r.slot.blockId === null && (
        <div className="slot-empty">
          <p>Empty slot</p>
          <p className="slot-empty-hint">Pick a block from the menu above.</p>
        </div>
      )}
    </div>
  );
}

const NEW_PREFIX = 'new:';

/**
 * Chooses which block a slot shows: any existing block (picking one shown in
 * another slot swaps them), or a brand-new instance of any app.
 */
function BlockPicker({
  layouts,
  apps,
  slotId,
  value,
  label,
}: {
  layouts: Layouts;
  apps: AppDescriptor[];
  slotId: string;
  value: string | null;
  label: string;
}) {
  const instances = knownInstances(layouts.blocks, apps);
  return (
    <select
      className="slot-app-picker"
      aria-label={label}
      value={value ?? ''}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = e.currentTarget.value;
        if (next.startsWith(NEW_PREFIX)) {
          const app = apps.find((a) => a.id === next.slice(NEW_PREFIX.length))!;
          layouts.createBlock(slotId, app.id, app.name);
        } else {
          layouts.setSlotBlock(slotId, next || null);
        }
      }}
    >
      <option value="">— Empty —</option>
      <optgroup label="Blocks">
        {instances.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="New instance">
        {apps.map((app) => (
          <option key={app.id} value={`${NEW_PREFIX}${app.id}`}>
            + New {app.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/**
 * Authoring form for one block: its name plus a control per setting the app
 * declared in its manifest. Changes apply live (the plugin is notified over its
 * thread) and are committed with the view on Save.
 */
function BlockSettingsPanel({
  instance,
  layouts,
  onClose,
}: {
  instance: Instance;
  layouts: Layouts;
  onClose(): void;
}) {
  const set = (key: string, value: SettingValue) =>
    layouts.updateBlock(instance.block, {settings: {[key]: value}});
  return (
    <aside className="block-settings" aria-label="Block settings">
      <header>
        <strong>Block settings</strong>
        <button className="slot-icon" aria-label="Close settings" onClick={onClose}>
          ✕
        </button>
      </header>
      <p className="block-settings-meta">
        {instance.app.name} · <code>{instance.id}</code>
      </p>
      <label className="block-field">
        <span>Block name</span>
        <input
          aria-label="Block name"
          value={instance.label}
          onInput={(e) => layouts.updateBlock(instance.block, {label: e.currentTarget.value})}
        />
      </label>
      {Object.entries(instance.app.settings ?? {}).map(([key, descriptor]) => (
        <SettingField
          key={key}
          descriptor={descriptor}
          value={instance.settings[key]}
          onChange={(value) => set(key, value)}
        />
      ))}
    </aside>
  );
}

function SettingField({
  descriptor: d,
  value,
  onChange,
}: {
  descriptor: SettingDescriptor;
  value: SettingValue | undefined;
  onChange(value: SettingValue): void;
}) {
  if (d.type === 'boolean') {
    return (
      <label className="block-field block-field-inline">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span>{d.label}</span>
        {d.description && <small>{d.description}</small>}
      </label>
    );
  }
  return (
    <label className="block-field">
      <span>{d.label}</span>
      {d.type === 'select' ? (
        <select
          aria-label={d.label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {d.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : d.type === 'number' ? (
        <input
          aria-label={d.label}
          type="number"
          min={d.min}
          max={d.max}
          step={d.step}
          value={Number(value ?? 0)}
          onInput={(e) => {
            const n = e.currentTarget.valueAsNumber;
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      ) : (
        <input
          aria-label={d.label}
          value={String(value ?? '')}
          onInput={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {d.description && <small>{d.description}</small>}
    </label>
  );
}
