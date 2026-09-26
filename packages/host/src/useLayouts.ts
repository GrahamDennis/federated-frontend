import {useCallback, useEffect, useLayoutEffect, useMemo, useState} from 'preact/hooks';
import type {BlockSettings} from '@ff/protocol';
import {
  DEFAULT_BLOCKS,
  DEFAULT_VIEWS,
  assignBlock,
  fullRect,
  growRect,
  isFull,
  newBlockId,
  rectOf,
  resolveSlots,
  setBinding,
  type BindingSource,
  type Block,
  type BlockRegistry,
  type Direction,
  type Enlargement,
  type LayoutView,
  type ValidationError,
} from '@ff/layout-model';
import {LayoutClient, LayoutRejected, type Role, type ServedLayouts} from './layoutClient';

const STORAGE_KEY = 'ff.layouts.v2';
const LEGACY_STORAGE_KEY = 'ff.layout-views.v1';

interface Stored {
  views: LayoutView[];
  blocks: BlockRegistry;
  /**
   * Default view ids already offered to this user. Defaults shipped later are
   * added on load, but ones the user has since deleted don't come back.
   */
  seenDefaults?: string[];
}

const DEFAULTS: Stored = {
  views: DEFAULT_VIEWS,
  blocks: DEFAULT_BLOCKS,
  seenDefaults: DEFAULT_VIEWS.map((v) => v.id),
};

/** Add default views/blocks shipped since the user's layouts were saved. */
function withNewDefaults(stored: Stored): Stored {
  const seen = new Set(stored.seenDefaults ?? stored.views.map((v) => v.id));
  const added = DEFAULT_VIEWS.filter(
    (d) => !seen.has(d.id) && !stored.views.some((v) => v.id === d.id),
  );
  return {
    views: [...stored.views, ...added],
    // Per block, so defaults gain fields added later (e.g. `name`).
    blocks: Object.fromEntries(
      [...new Set([...Object.keys(DEFAULT_BLOCKS), ...Object.keys(stored.blocks)])].map((id) => [
        id,
        {...DEFAULT_BLOCKS[id], ...stored.blocks[id]},
      ]),
    ),
    seenDefaults: DEFAULT_VIEWS.map((v) => v.id),
  };
}

/**
 * Local mode (no layout service reachable): saved views and blocks persist in
 * localStorage, seeded with the defaults.
 */
function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Stored;
      if (Array.isArray(parsed.views) && parsed.views.length > 0) {
        return withNewDefaults({...parsed, blocks: parsed.blocks ?? {}});
      }
    }
    // v1 stored only views, with slots naming an app. The default block of an
    // app has the app's id, so migrating is a field rename.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const views = (JSON.parse(legacy) as LayoutView[]).map((view) => ({
        ...view,
        slots: view.slots.map(({appId, ...slot}: any) => ({...slot, blockId: appId ?? null})),
      }));
      return withNewDefaults({views, blocks: {}, seenDefaults: []});
    }
  } catch {
    // Storage unavailable or corrupt: fall back to the defaults.
  }
  return DEFAULTS;
}

function store(stored: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Non-fatal: the layouts just won't survive a reload.
  }
}

const ROLE_KEY = 'ff.role';
const WORKSPACE_KEY = 'ff.workspace';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A per-viewer convenience only.
  }
}

/** Shown when a role can see no views at all. */
const NO_VIEWS: LayoutView = {id: '__none', name: 'No views for this role', cols: 1, rows: 1, slots: []};

/**
 * Where layouts come from: the layout service (per role and workspace), or —
 * if it can't be reached — localStorage, as before.
 */
export type LayoutSource = 'loading' | 'service' | 'local';

interface Draft {
  view: LayoutView;
  blocks: BlockRegistry;
  /** A brand-new view (not yet in the saved views). */
  isNew: boolean;
}

/**
 * All the layout-mode state: the saved views and blocks, which view is active,
 * the user's ad-hoc (unsaved) edits to each view, a temporary enlargement, and
 * the edit-mode draft.
 *
 * Two tiers of change, mirroring "admin defines formats, operator adjusts them":
 * - **Edit mode** works on a `draft` copy of a view *and* the block registry
 *   (geometry, which block each slot shows, block names and settings) and
 *   commits both on Save.
 * - **User mode** changes (swapping a slot's block) go to a per-view `live`
 *   copy that is never saved; "Reset" drops it back to the saved definition.
 *   Enlargement is even more transient: it's cleared whenever the view changes.
 */
function useDraftViewUpdater(setDraft: (fn: (d: Draft | null) => Draft | null) => void) {
  return useCallback(
    (fn: (v: LayoutView) => LayoutView) => setDraft((d) => d && {...d, view: fn(d.view)}),
    [setDraft],
  );
}

export function useLayouts(initialViewId: string | null) {
  const [saved, setSaved] = useState<Stored>({views: [], blocks: {}});
  const {views} = saved;
  const [activeViewId, setActiveViewId] = useState<string>(initialViewId ?? '');

  // ---- Source: the layout service, per role + workspace; or local fallback ----
  const [source, setSource] = useState<LayoutSource>('loading');
  const [roles, setRoles] = useState<Role[]>([]);
  const [role, setRoleState] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [workspace] = useState(() => {
    const ws = readPref(WORKSPACE_KEY);
    return ws && /^[A-Za-z0-9_-]{1,64}$/.test(ws) ? ws : 'default';
  });
  const client = useMemo(() => (role ? new LayoutClient(role, workspace) : null), [role, workspace]);
  const [saveErrors, setSaveErrors] = useState<ValidationError[]>([]);
  const [saving, setSaving] = useState(false);

  const goLocal = useCallback(() => {
    setSource('local');
    setSaved(load());
    setCanEdit(true);
    setRoles([]);
  }, []);

  // Which roles exist, and ours (remembered per viewer; else the default).
  useEffect(() => {
    let cancelled = false;
    LayoutClient.roles()
      .then(({defaultRole, roles}) => {
        if (cancelled) return;
        setRoles(roles);
        const preferred = readPref(ROLE_KEY);
        setRoleState(roles.some((r) => r.id === preferred) ? preferred : defaultRole);
      })
      .catch(() => !cancelled && goLocal());
    return () => {
      cancelled = true;
    };
  }, [goLocal]);

  const applyServed = useCallback((served: ServedLayouts) => {
    setSaved({views: served.views, blocks: served.blocks});
    setCanEdit(served.canEdit);
    setSource('service');
  }, []);

  // The layouts this role may see, whenever the role changes.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .load()
      .then((served) => !cancelled && applyServed(served))
      .catch(() => !cancelled && goLocal());
    return () => {
      cancelled = true;
    };
  }, [client, applyServed, goLocal]);
  const [liveByView, setLiveByView] = useState<Record<string, LayoutView>>({});
  const [enlargement, setEnlargement] = useState<Enlargement | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const updateDraftView = useDraftViewUpdater(setDraft);

  // Local mode only. Persist in the commit (a layout effect), not after paint:
  // a plain effect can lose the write if the page is reloaded right after Save.
  useLayoutEffect(() => {
    if (source === 'local') store(saved);
  }, [saved, source]);

  const savedView = views.find((v) => v.id === activeViewId) ?? views[0] ?? NO_VIEWS;
  const live = liveByView[savedView.id] ?? savedView;
  /** What's on screen: the draft while editing, else the live copy. */
  const view = draft?.view ?? live;
  /** The block registry in effect (the draft's while editing). */
  const blocks = draft?.blocks ?? saved.blocks;
  const resolved = useMemo(
    () => resolveSlots(view, draft ? null : enlargement),
    [view, draft, enlargement],
  );

  const selectView = useCallback((id: string) => {
    setActiveViewId(id);
    setEnlargement(null);
  }, []);

  const updateLive = useCallback(
    (fn: (v: LayoutView) => LayoutView) =>
      setLiveByView((all) => ({
        ...all,
        [savedView.id]: fn(all[savedView.id] ?? savedView),
      })),
    [savedView],
  );

  /** Apply a view change to the draft (edit mode) or the live copy (user mode). */
  const updateView = useCallback(
    (fn: (v: LayoutView) => LayoutView) => {
      if (draft) setDraft((d) => d && {...d, view: fn(d.view)});
      else updateLive(fn);
    },
    [draft, updateLive],
  );

  const setSlotBlock = useCallback(
    (slotId: string, blockId: string | null) =>
      updateView((v) => assignBlock(v, slotId, blockId)),
    [updateView],
  );

  /** Create another instance of `appId` and show it in `slotId`. */
  const createBlock = useCallback(
    (slotId: string, appId: string, appName: string) => {
      const ids = [...Object.keys(blocks), ...views.flatMap((v) => v.slots.map((s) => s.blockId ?? ''))];
      const id = newBlockId(appId, ids);
      const block: Block = {id, appId, label: `${appName} ${id.split('~')[1]}`};
      // A new block is harmless until referenced, so in user mode it's added to
      // the saved registry straight away (only the slot assignment is ad hoc).
      if (draft) setDraft((d) => d && {...d, blocks: {...d.blocks, [id]: block}});
      else setSaved((s) => ({...s, blocks: {...s.blocks, [id]: block}}));
      updateView((v) => assignBlock(v, slotId, id));
    },
    [blocks, views, draft, updateView],
  );

  /** Edit a block's label/settings (edit mode only; takes effect live). */
  const updateBlock = useCallback(
    (base: Block, patch: {label?: string; settings?: BlockSettings}) => {
      setDraft(
        (d) =>
          d && {
            ...d,
            blocks: {
              ...d.blocks,
              [base.id]: {
                ...base,
                ...(d.blocks[base.id] ?? {}),
                ...(patch.label !== undefined ? {label: patch.label} : {}),
                settings: {
                  ...(d.blocks[base.id]?.settings ?? base.settings ?? {}),
                  ...(patch.settings ?? {}),
                },
              },
            },
          },
      );
    },
    [],
  );

  /** Wire (or unwire) one block input in the draft view (edit mode only). */
  const setInputBinding = useCallback(
    (blockId: string, input: string, source: BindingSource | null) =>
      updateDraftView((v) => setBinding(v, blockId, input, source)),
    [],
  );

  /** Saved views (other than the one being edited) that show `blockId`. */
  const viewsUsingBlock = useCallback(
    (blockId: string) =>
      views
        .filter((v) => v.id !== draft?.view.id)
        .filter((v) => v.slots.some((s) => s.blockId === blockId))
        .map((v) => v.name),
    [views, draft?.view.id],
  );

  /**
   * Delete an explicit block from the draft registry, emptying its slots and
   * dropping its wiring in the draft view. Refused while other views use it.
   */
  const deleteBlock = useCallback(
    (blockId: string) => {
      if (viewsUsingBlock(blockId).length > 0) return;
      setDraft((d) => {
        if (!d) return d;
        const {[blockId]: _deleted, ...blocks} = d.blocks;
        return {
          ...d,
          blocks,
          view: {
            ...d.view,
            slots: d.view.slots.map((s) => (s.blockId === blockId ? {...s, blockId: null} : s)),
            bindings: (d.view.bindings ?? []).filter(
              // Direct wires from it go; an expression that mentions it stays and
              // shows an "unknown variable" error in the editor until fixed.
              (b) => b.blockId !== blockId && b.from?.blockId !== blockId,
            ),
          },
        };
      });
    },
    [viewsUsingBlock],
  );

  const resetView = useCallback(() => {
    setLiveByView(({[savedView.id]: _dropped, ...rest}) => rest);
    setEnlargement(null);
  }, [savedView.id]);

  const expandSlot = useCallback(
    (slotId: string, dir: Direction) => {
      const slot = view.slots.find((s) => s.id === slotId);
      if (!slot) return;
      const from = enlargement?.slotId === slotId ? enlargement.rect : rectOf(slot);
      const rect = growRect(view, from, dir);
      if (rect) setEnlargement({slotId, rect});
    },
    [view, enlargement],
  );

  const toggleMaximize = useCallback(
    (slotId: string) => {
      const maximized = enlargement?.slotId === slotId && isFull(view, enlargement.rect);
      setEnlargement(maximized ? null : {slotId, rect: fullRect(view)});
    },
    [view, enlargement],
  );

  const restoreSlot = useCallback(() => setEnlargement(null), []);

  /** Switch role (service mode): reloads the layouts that role may see. */
  const setRole = useCallback((next: string) => {
    writePref(ROLE_KEY, next);
    setRoleState(next);
    setDraft(null);
    setLiveByView({});
    setEnlargement(null);
    setSaveErrors([]);
  }, []);

  /** Which roles may use the view being edited (service mode). */
  const setViewRoles = useCallback(
    (next: string[]) => updateDraftView((v) => ({...v, roles: next})),
    [updateDraftView],
  );

  // ---- Edit mode ----
  const startEditing = useCallback(() => {
    if (savedView === NO_VIEWS) return;
    setDraft({view: structuredClone(savedView), blocks: structuredClone(saved.blocks), isNew: false});
    setEnlargement(null);
    setSaveErrors([]);
  }, [savedView, saved.blocks]);

  const newDraft = useCallback((copyOf?: LayoutView) => {
    const id = `view-${Date.now().toString(36)}`;
    setDraft((d) => ({
      blocks: d?.blocks ?? structuredClone(saved.blocks),
      isNew: true,
      view: copyOf
        ? {...structuredClone(copyOf), id, name: `${copyOf.name} copy`}
        : {id, name: 'New view', cols: 3, rows: 2, slots: []},
    }));
  }, [saved.blocks]);


  const cancelEditing = useCallback(() => {
    setDraft(null);
    setSaveErrors([]);
  }, []);

  /** Run a service mutation; a rejection (e.g. validation) keeps the draft open. */
  const mutate = useCallback(
    async (call: (c: LayoutClient) => Promise<ServedLayouts>, after?: (s: ServedLayouts) => void) => {
      if (!client) return;
      setSaving(true);
      try {
        const served = await call(client);
        applyServed(served);
        setDraft(null);
        setSaveErrors([]);
        after?.(served);
      } catch (error) {
        setSaveErrors(
          error instanceof LayoutRejected && error.errors.length > 0
            ? error.errors
            : [{path: '', message: error instanceof Error ? error.message : String(error)}],
        );
      } finally {
        setSaving(false);
      }
    },
    [client, applyServed],
  );

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const {view: next, blocks: nextBlocks} = draft;
    if (source === 'service') {
      // The service validates (CEL, wiring, geometry) and may reject the save.
      void mutate(
        (c) => c.saveView(next, nextBlocks),
        () => {
          setLiveByView(({[next.id]: _dropped, ...rest}) => rest);
          setActiveViewId(next.id);
        },
      );
      return;
    }
    setSaved((s) => ({
      ...s,
      blocks: nextBlocks,
      views: s.views.some((v) => v.id === next.id)
        ? s.views.map((v) => (v.id === next.id ? next : v))
        : [...s.views, next],
    }));
    // The saved definition changed, so any ad-hoc edits to it are stale.
    setLiveByView(({[next.id]: _dropped, ...rest}) => rest);
    setActiveViewId(next.id);
    setDraft(null);
  }, [draft, source, mutate]);

  const deleteView = useCallback(() => {
    if (!draft) return;
    const remaining = views.filter((v) => v.id !== draft.view.id);
    if (remaining.length === 0) return;
    if (source === 'service') {
      void mutate((c) => c.deleteView(draft.view.id), () => setActiveViewId(remaining[0].id));
      return;
    }
    setSaved((s) => ({...s, views: remaining}));
    setActiveViewId(remaining[0].id);
    setDraft(null);
  }, [draft, views, source, mutate]);

  const resetToDefaults = useCallback(() => {
    if (source === 'service') {
      void mutate((c) => c.reset(), () => {
        setLiveByView({});
        setEnlargement(null);
      });
      return;
    }
    setSaved(DEFAULTS);
    setLiveByView({});
    setActiveViewId(DEFAULT_VIEWS[0].id);
    setDraft(null);
    setEnlargement(null);
  }, [source, mutate]);

  return {
    ready: source !== 'loading',
    source,
    roles,
    role,
    setRole,
    canEdit,
    saveErrors,
    saving,
    setViewRoles,
    views,
    blocks,
    activeViewId: savedView.id,
    view,
    resolved,
    enlargement,
    editing: draft !== null,
    draftIsNew: draft?.isNew ?? false,
    hasAdHocChanges: Boolean(liveByView[savedView.id]) || enlargement !== null,
    selectView,
    setSlotBlock,
    createBlock,
    updateBlock,
    resetView,
    expandSlot,
    toggleMaximize,
    restoreSlot,
    startEditing,
    newDraft,
    updateDraft: updateDraftView,
    setInputBinding,
    viewsUsingBlock,
    deleteBlock,
    cancelEditing,
    saveDraft,
    deleteView,
    resetToDefaults,
  };
}

export type Layouts = ReturnType<typeof useLayouts>;
