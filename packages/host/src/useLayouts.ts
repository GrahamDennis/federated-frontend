import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'preact/hooks';
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
  blockChanges,
  blockRenames,
  renameInView,
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
import {subscribeLayoutEvents} from './layoutEvents';
import {
  AuthExpired,
  LayoutClient,
  LayoutConflict,
  LayoutRejected,
  type Conflict,
  type DevUser,
  type Me,
  type Role,
  type ServedLayouts,
  type UserState,
} from './layoutClient';

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

const USER_KEY = 'ff.user';
/**
 * The session token. localStorage is the prototype's choice (plugins are
 * cross-origin iframes, so they can't read it); production would prefer an
 * httpOnly cookie from the identity provider.
 */
const TOKEN_KEY = 'ff.token';
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
  /** The registry this edit started from — saves send only the difference. */
  baseBlocks: BlockRegistry;
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

  // ---- Source: the layout service (signed in), or local fallback ----
  const [source, setSource] = useState<LayoutSource>('loading');
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<DevUser[]>([]);
  const [session, setSession] = useState<{token: string; me: Me} | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [workspace] = useState(() => {
    const ws = readPref(WORKSPACE_KEY);
    return ws && /^[A-Za-z0-9_-]{1,64}$/.test(ws) ? ws : 'default';
  });
  const client = useMemo(() => (session ? new LayoutClient(session.token) : null), [session]);
  const [saveErrors, setSaveErrors] = useState<ValidationError[]>([]);
  /** A save lost a race with another editor: what changed, and their latest. */
  const [conflict, setConflict] = useState<{conflicts: Conflict[]; current: ServedLayouts} | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  const goLocal = useCallback(() => {
    setSource('local');
    setSaved(load());
    setCanEdit(true);
    setRoles([]);
    setUsers([]);
  }, []);

  /** DEV sign-in as a configured user (stands in for an identity provider). */
  const signInAs = useCallback(
    async (userId: string) => {
      const token = await LayoutClient.devLogin(userId, workspace);
      const me = await new LayoutClient(token).me();
      writePref(TOKEN_KEY, token);
      writePref(USER_KEY, userId);
      return {token, me};
    },
    [workspace],
  );

  // Sign in: reuse a stored token if it's still valid for this workspace;
  // otherwise (dev) sign in as the remembered user, or the default one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [auth, {roles}] = await Promise.all([LayoutClient.auth(), LayoutClient.roles()]);
        if (cancelled) return;
        setUsers(auth.users);
        setRoles(roles);
        const stored = readPref(TOKEN_KEY);
        const me = stored ? await new LayoutClient(stored).me().catch(() => null) : null;
        if (me && stored && me.workspace === workspace) {
          if (!cancelled) setSession({token: stored, me});
          return;
        }
        const preferred = readPref(USER_KEY);
        const user = auth.users.some((u) => u.id === preferred) ? preferred! : auth.defaultUser;
        const next = await signInAs(user);
        if (!cancelled) setSession(next);
      } catch {
        if (!cancelled) goLocal();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goLocal, signInAs, workspace]);

  const applyServed = useCallback((served: ServedLayouts) => {
    setSaved({views: served.views, blocks: served.blocks});
    setCanEdit(served.canEdit);
    setSource('service');
  }, []);

  const [liveByView, setLiveByView] = useState<Record<string, LayoutView>>({});
  const [enlargement, setEnlargement] = useState<Enlargement | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const updateDraftView = useDraftViewUpdater(setDraft);
  /** Blocks this user created in user mode (service mode: private to them). */
  const [adHocBlocks, setAdHocBlocks] = useState<BlockRegistry>({});

  // Per-user state sync: what was last loaded/sent (null until loaded, so
  // nothing is written before the user's saved state has been read), and a
  // queue so writes land in order.
  const stateSent = useRef<string | null>(null);
  const stateQueue = useRef<Promise<void>>(Promise.resolve());

  // For the signed-in user: the layouts their role may see, plus their own
  // ad-hoc changes — loaded together so a user switch can't mix them up.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    stateSent.current = null;
    void (async () => {
      try {
        const served = await client.load();
        const state: UserState = await client
          .getState()
          .catch(() => ({liveByView: {}, blocks: {}}));
        if (cancelled) return;
        // Keep only copies still based on the current approved revision.
        const liveByView = Object.fromEntries(
          Object.entries(state.liveByView).filter(
            ([id, copy]) => served.views.find((v) => v.id === id)?.rev === copy.rev,
          ),
        );
        applyServed(served);
        setLiveByView(liveByView);
        setAdHocBlocks(state.blocks ?? {});
        stateSent.current = JSON.stringify({liveByView, blocks: state.blocks ?? {}});
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AuthExpired && session) {
          // Expired or revoked: sign in again as the same user.
          writePref(TOKEN_KEY, '');
          signInAs(session.me.user.id).then(setSession, goLocal);
        } else {
          goLocal();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session, applyServed, goLocal, signInAs]);

  // ---- Live updates & presence (service mode) ----
  const [connected, setConnected] = useState(false);
  const [connId, setConnId] = useState<string | null>(null);
  const [presence, setPresence] = useState<
    {connId: string; user: string; name: string; viewId: string}[]
  >([]);
  /** The view being edited was changed (or deleted) by someone else. */
  const [stale, setStale] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /** Drop ad-hoc copies whose approved view has moved on (or gone). */
  const keepFreshCopies = useCallback(
    (copies: Record<string, LayoutView>, fresh: LayoutView[]) =>
      Object.fromEntries(
        Object.entries(copies).filter(
          ([id, copy]) => fresh.find((v) => v.id === id)?.rev === copy.rev,
        ),
      ),
    [],
  );

  // Someone changed layouts: refetch what this role sees, drop stale ad-hoc
  // copies, and warn (before they save) anyone editing a view that changed.
  const onLayoutsChanged = useCallback(
    async (data: {views: string[]; by: {id: string; name: string}}) => {
      if (!client) return;
      let served: ServedLayouts;
      try {
        served = await client.load();
      } catch {
        return;
      }
      applyServed(served);
      setLiveByView((copies) => keepFreshCopies(copies, served.views));
      const d = draftRef.current;
      if (d && !d.isNew && data.views.includes(d.view.id)) {
        const current = served.views.find((v) => v.id === d.view.id);
        if (!current) setStale(`${data.by.name} deleted this view while you were editing it.`);
        else if (current.rev !== d.view.rev) {
          setStale(`${data.by.name} saved a newer version of this view while you were editing it.`);
        }
      }
    },
    [client, applyServed, keepFreshCopies],
  );
  const onLayoutsChangedRef = useRef(onLayoutsChanged);
  onLayoutsChangedRef.current = onLayoutsChanged;

  useEffect(() => {
    if (!session || source !== 'service') return;
    return subscribeLayoutEvents(
      session.token,
      ({event, data}) => {
        if (event === 'hello') setConnId(data.connId);
        else if (event === 'presence') setPresence(data);
        else if (event === 'layouts-changed') void onLayoutsChangedRef.current(data);
      },
      (connected) => {
        setConnected(connected);
        if (!connected) {
          setConnId(null);
          setPresence([]);
        }
      },
    );
  }, [session, source === 'service']);

  // Tell others which view this connection is editing.
  const editingViewId = draft && !draft.isNew ? draft.view.id : null;
  useEffect(() => {
    if (client && connId) void client.setPresence(connId, editingViewId).catch(() => {});
  }, [client, connId, editingViewId]);

  // Save the user's ad-hoc changes whenever they change (service mode).
  useEffect(() => {
    if (source !== 'service' || !client || stateSent.current === null) return;
    const state: UserState = {liveByView, blocks: adHocBlocks};
    const json = JSON.stringify(state);
    if (json === stateSent.current) return;
    stateSent.current = json;
    stateQueue.current = stateQueue.current.then(() => client.putState(state)).catch(() => {});
  }, [liveByView, adHocBlocks, source, client]);

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
  const savedWithAdHoc = useMemo(
    () => ({...saved.blocks, ...adHocBlocks}),
    [saved.blocks, adHocBlocks],
  );
  const blocks = draft?.blocks ?? savedWithAdHoc;
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
      // In edit mode it joins the draft. In user mode it's this user's own: with
      // the service, kept in their private state; locally, in the registry.
      if (draft) setDraft((d) => d && {...d, blocks: {...d.blocks, [id]: block}});
      else if (source === 'service') setAdHocBlocks((b) => ({...b, [id]: block}));
      else setSaved((s) => ({...s, blocks: {...s.blocks, [id]: block}}));
      updateView((v) => assignBlock(v, slotId, id));
    },
    [blocks, views, draft, updateView, source],
  );

  /** Edit a block's label/settings (edit mode only; takes effect live). */
  const updateBlock = useCallback(
    (base: Block, patch: {label?: string; name?: string; settings?: BlockSettings}) => {
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
                ...(patch.name !== undefined ? {name: patch.name} : {}),
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

  /**
   * Rename a block's expression name (edit mode): the block and every
   * expression in the draft view change now; on save, other views that refer
   * to it are rewritten too (by the service, or locally).
   */
  const renameBlock = useCallback(
    (base: Block, from: string, to: string) => {
      updateBlock(base, {name: to});
      updateDraftView((v) => renameInView(v, from, to));
    },
    [updateBlock, updateDraftView],
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

  /** DEV: sign in as another user — reloads their role's views and their own state. */
  const switchUser = useCallback(
    async (userId: string) => {
      const next = await signInAs(userId);
      stateSent.current = null;
      // Back to "loading" until this user's layouts and state arrive, so
      // nothing can be changed against the previous user's layout meanwhile.
      setSource('loading');
      setDraft(null);
      setLiveByView({});
      setAdHocBlocks({});
      setEnlargement(null);
      setSaveErrors([]);
      setConflict(null);
      setSession(next);
    },
    [signInAs],
  );

  /** Which roles may use the view being edited (service mode). */
  const setViewRoles = useCallback(
    (next: string[]) => updateDraftView((v) => ({...v, roles: next})),
    [updateDraftView],
  );

  // ---- Edit mode ----
  const startEditing = useCallback(() => {
    if (savedView === NO_VIEWS) return;
    setDraft({
      view: structuredClone(savedView),
      blocks: structuredClone(saved.blocks),
      baseBlocks: saved.blocks,
      isNew: false,
    });
    setConflict(null);
    setEnlargement(null);
    setSaveErrors([]);
    setStale(null);
  }, [savedView, saved.blocks]);

  const newDraft = useCallback((copyOf?: LayoutView) => {
    const id = `view-${Date.now().toString(36)}`;
    setDraft((d) => ({
      blocks: d?.blocks ?? structuredClone(saved.blocks),
      baseBlocks: d?.baseBlocks ?? saved.blocks,
      isNew: true,
      view: copyOf
        ? {...structuredClone(copyOf), id, name: `${copyOf.name} copy`}
        : {id, name: 'New view', cols: 3, rows: 2, slots: []},
    }));
  }, [saved.blocks]);


  const cancelEditing = useCallback(() => {
    setDraft(null);
    setSaveErrors([]);
    setConflict(null);
    setStale(null);
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
        setConflict(null);
        setStale(null);
        after?.(served);
      } catch (error) {
        if (error instanceof LayoutConflict) {
          setConflict({conflicts: error.conflicts, current: error.current});
          setSaveErrors([]);
          return;
        }
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
      // The service checks revisions (409 on a lost race) and validates (CEL,
      // wiring, geometry; 422). Only the blocks this edit touched are sent.
      const {changed, deleted} = blockChanges(draft.baseBlocks, nextBlocks);
      void mutate(
        (c) => c.saveView(next, changed, deleted),
        () => {
          setLiveByView(({[next.id]: _dropped, ...rest}) => rest);
          setActiveViewId(next.id);
        },
      );
      return;
    }
    const renames = blockRenames(draft.baseBlocks, nextBlocks);
    setSaved((s) => {
      // The saved view, plus other views rewritten for any renamed blocks.
      const views = s.views.map((v) =>
        v.id === next.id ? next : renames.reduce((acc, r) => renameInView(acc, r.from, r.to), v),
      );
      return {
        ...s,
        blocks: nextBlocks,
        views: views.some((v) => v.id === next.id) ? views : [...views, next],
      };
    });
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
      void mutate(
        (c) => c.deleteView(draft.view.id, draft.view.rev),
        () => setActiveViewId(remaining[0].id),
      );
      return;
    }
    setSaved((s) => ({...s, views: remaining}));
    setActiveViewId(remaining[0].id);
    setDraft(null);
  }, [draft, views, source, mutate]);

  /** Resolve a conflict (or a stale draft) by discarding this edit and loading the latest. */
  const reloadLatest = useCallback(() => {
    if (conflict) applyServed(conflict.current);
    else if (client) void client.load().then(applyServed, () => {});
    setDraft(null);
    setConflict(null);
    setStale(null);
    setSaveErrors([]);
  }, [conflict, client, applyServed]);

  /**
   * Resolve a conflict by saving this edit over theirs: the same changes,
   * rebased onto the current revisions. Only what *this* edit changed is
   * overwritten — blocks someone else added or changed otherwise are kept.
   */
  const overwriteTheirs = useCallback(() => {
    if (!conflict || !draft) return;
    const {current} = conflict;
    const view = {...draft.view, rev: current.views.find((v) => v.id === draft.view.id)?.rev};
    const {changed, deleted} = blockChanges(draft.baseBlocks, draft.blocks);
    const revOf = (id: string) => current.blocks[id]?.rev;
    void mutate(
      (c) =>
        c.saveView(
          view,
          changed.map((b) => ({...b, rev: revOf(b.id)})),
          deleted.map(({id}) => ({id, rev: revOf(id)})),
        ),
      () => {
        setLiveByView(({[view.id]: _dropped, ...rest}) => rest);
        setActiveViewId(view.id);
      },
    );
  }, [conflict, draft, mutate]);

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
    users,
    me: session?.me ?? null,
    switchUser,
    canEdit,
    saveErrors,
    conflict: conflict?.conflicts ?? null,
    stale,
    /** Whether live updates are connected. */
    live: connected,
    /** Others (other connections) currently editing each view. */
    othersEditing: presence.filter((p) => p.connId !== connId),
    reloadLatest,
    overwriteTheirs,
    saving,
    setViewRoles,
    renameBlock,
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
