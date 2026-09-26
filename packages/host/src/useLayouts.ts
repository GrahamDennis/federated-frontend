import {useCallback, useEffect, useMemo, useState} from 'preact/hooks';
import {
  DEFAULT_VIEWS,
  assignApp,
  fullRect,
  growRect,
  isFull,
  rectOf,
  resolveSlots,
  type Direction,
  type Enlargement,
  type LayoutView,
} from './layout';

const STORAGE_KEY = 'ff.layout-views.v1';

/**
 * Saved views are the admin-authored definitions. In a real deployment they'd be
 * served (per role / per mission) by a backend; for the prototype they persist in
 * localStorage, seeded with {@link DEFAULT_VIEWS}.
 */
function loadViews(): LayoutView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LayoutView[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // Storage unavailable or corrupt: fall back to the defaults.
  }
  return DEFAULT_VIEWS;
}

function storeViews(views: LayoutView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Non-fatal: the views just won't survive a reload.
  }
}

/**
 * All the layout-mode state: the saved views, which one is active, the user's
 * ad-hoc (unsaved) edits to each, a temporary enlargement, and the edit-mode draft.
 *
 * Two tiers of change, mirroring "admin defines formats, operator adjusts them":
 * - **Edit mode** works on a `draft` copy of a view (geometry + default apps) and
 *   commits it to the saved views on Save.
 * - **User mode** changes (swapping a slot's app) go to a per-view `live` copy that
 *   is never saved; "Reset" drops it back to the saved definition. Enlargement is
 *   even more transient: it's cleared whenever the view changes.
 */
export function useLayouts(initialViewId: string | null) {
  const [views, setViews] = useState<LayoutView[]>(loadViews);
  const [activeViewId, setActiveViewId] = useState<string>(() =>
    views.some((v) => v.id === initialViewId) ? initialViewId! : views[0].id,
  );
  const [liveByView, setLiveByView] = useState<Record<string, LayoutView>>({});
  const [enlargement, setEnlargement] = useState<Enlargement | null>(null);
  const [draft, setDraft] = useState<LayoutView | null>(null);
  // Whether the draft is a brand-new view (not yet in `views`).
  const [draftIsNew, setDraftIsNew] = useState(false);

  useEffect(() => storeViews(views), [views]);

  const saved = views.find((v) => v.id === activeViewId) ?? views[0];
  const live = liveByView[saved.id] ?? saved;
  /** What's on screen: the draft while editing, else the live copy. */
  const view = draft ?? live;
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
      setLiveByView((all) => ({...all, [saved.id]: fn(all[saved.id] ?? saved)})),
    [saved],
  );

  const setSlotApp = useCallback(
    (slotId: string, appId: string | null) => {
      if (draft) setDraft(assignApp(draft, slotId, appId));
      else updateLive((v) => assignApp(v, slotId, appId));
    },
    [draft, updateLive],
  );

  const resetView = useCallback(() => {
    setLiveByView(({[saved.id]: _dropped, ...rest}) => rest);
    setEnlargement(null);
  }, [saved.id]);

  const expandSlot = useCallback(
    (slotId: string, dir: Direction) => {
      const slot = view.slots.find((s) => s.id === slotId);
      if (!slot) return;
      const from =
        enlargement?.slotId === slotId ? enlargement.rect : rectOf(slot);
      const rect = growRect(view, from, dir);
      if (rect) setEnlargement({slotId, rect});
    },
    [view, enlargement],
  );

  const toggleMaximize = useCallback(
    (slotId: string) => {
      const maximized =
        enlargement?.slotId === slotId && isFull(view, enlargement.rect);
      setEnlargement(maximized ? null : {slotId, rect: fullRect(view)});
    },
    [view, enlargement],
  );

  const restoreSlot = useCallback(() => setEnlargement(null), []);

  // ---- Edit mode ----
  const startEditing = useCallback(() => {
    setDraft(structuredClone(saved));
    setDraftIsNew(false);
    setEnlargement(null);
  }, [saved]);

  const newDraft = useCallback((copyOf?: LayoutView) => {
    const id = `view-${Date.now().toString(36)}`;
    setDraft(
      copyOf
        ? {...structuredClone(copyOf), id, name: `${copyOf.name} copy`}
        : {id, name: 'New view', cols: 3, rows: 2, slots: []},
    );
    setDraftIsNew(true);
  }, []);

  const cancelEditing = useCallback(() => setDraft(null), []);

  const saveDraft = useCallback(() => {
    if (!draft) return;
    setViews((all) =>
      all.some((v) => v.id === draft.id)
        ? all.map((v) => (v.id === draft.id ? draft : v))
        : [...all, draft],
    );
    // The saved definition changed, so any ad-hoc edits to it are stale.
    setLiveByView(({[draft.id]: _dropped, ...rest}) => rest);
    setActiveViewId(draft.id);
    setDraft(null);
  }, [draft]);

  const deleteView = useCallback(() => {
    if (!draft) return;
    const remaining = views.filter((v) => v.id !== draft.id);
    if (remaining.length === 0) return;
    setViews(remaining);
    setActiveViewId(remaining[0].id);
    setDraft(null);
  }, [draft, views]);

  const resetToDefaults = useCallback(() => {
    setViews(DEFAULT_VIEWS);
    setLiveByView({});
    setActiveViewId(DEFAULT_VIEWS[0].id);
    setDraft(null);
    setEnlargement(null);
  }, []);

  return {
    views,
    activeViewId: saved.id,
    view,
    resolved,
    enlargement,
    editing: draft !== null,
    draftIsNew,
    hasAdHocChanges: Boolean(liveByView[saved.id]) || enlargement !== null,
    selectView,
    setSlotApp,
    resetView,
    expandSlot,
    toggleMaximize,
    restoreSlot,
    startEditing,
    newDraft,
    updateDraft: setDraft as (fn: (v: LayoutView | null) => LayoutView | null) => void,
    cancelEditing,
    saveDraft,
    deleteView,
    resetToDefaults,
  };
}

export type Layouts = ReturnType<typeof useLayouts>;
