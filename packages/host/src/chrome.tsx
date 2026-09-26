import {createContext} from 'preact';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import type {
  BlockInputs,
  BlockSettings,
  CommandDescriptor,
  InstanceInfo,
  PortValue,
  ForwardedKeyEvent,
  SharedContext,
  ToastOptions,
  ToastTone,
} from '@ff/protocol';
import type {AppDescriptor} from './apps';
import {AppView} from './AppView';
import {readWorkspaceFromUrl, writeWorkspaceToUrl} from './workspaceUrl';
import {gridArea, resolveInputs, type Rect} from './layout';
import {useInstanceFeed} from './instanceFeed';
import {LayoutBar, SlotLayer, gridTemplate} from './LayoutStage';
import {useLayouts} from './useLayouts';
import {instanceFor, type Instance} from './instances';

/**
 * The host chrome's shared services. Plugin hosts get at these (via {@link useChrome})
 * to fulfil the capability API, and the host-side remote components use the portal
 * targets to teleport plugin-contributed UI into the chrome.
 */
interface ChromeContextValue {
  toast(message: string, options?: ToastOptions): void;
  /** Replace the command-palette entries contributed by one plugin instance. */
  setCommandsForInstance(instanceId: string, commands: CommandDescriptor[]): void;
  /** Which block a plugin instance is, and its (live) resolved settings. */
  getInstanceInfo(instanceId: string): InstanceInfo;
  getInstanceSettings(instanceId: string): BlockSettings;
  subscribeInstanceSettings(
    instanceId: string,
    listener: (settings: BlockSettings) => void,
  ): () => void;
  /** Wiring between blocks: outputs a plugin publishes, inputs it's fed. */
  publishOutput(instanceId: string, output: string, value: PortValue | null): void;
  getInstanceInputs(instanceId: string): BlockInputs;
  subscribeInstanceInputs(
    instanceId: string,
    listener: (inputs: BlockInputs) => void,
  ): () => void;
  /** All registered apps (so a plugin can be offered its siblings). */
  apps: AppDescriptor[];
  /** Bring an app to the foreground. */
  activateApp(appId: string): void;
  /** Shared workspace context (broker for composing apps around one selection). */
  getSharedContext(): SharedContext;
  setSharedContext(patch: SharedContext): void;
  subscribeSharedContext(listener: (context: SharedContext) => void): () => void;
  /** Run a keyboard shortcut forwarded from a focused plugin iframe. */
  handleForwardedShortcut(event: ForwardedKeyEvent): void;
  /** DOM node in the top nav where plugins portal their toolbar sections. */
  toolbarSlot: HTMLElement | null;
  /** DOM node (full-window overlay) where plugins portal modals/popovers. */
  modalLayer: HTMLElement | null;
}

const ChromeContext = createContext<ChromeContextValue | null>(null);

export function useChrome(): ChromeContextValue {
  const value = useContext(ChromeContext);
  if (!value) throw new Error('useChrome must be used within <Chrome>');
  return value;
}

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

let nextToastId = 1;

export function Chrome({apps}: {apps: AppDescriptor[]}) {
  // Initial workspace (primary app, docked detail, shared selection) comes from
  // the URL, so deep links / reloads restore the composed view.
  const initial = useMemo(() => readWorkspaceFromUrl(apps), [apps]);

  const [activeAppId, setActiveAppId] = useState(initial.appId);

  // Two ways to compose the workspace: `apps` (one primary app, optionally with a
  // docked detail companion) or `layout` (a grid of slots from a saved view).
  const [mode, setMode] = useState(initial.mode);
  const layouts = useLayouts(initial.viewId);
  const layoutMode = mode === 'layout';

  // Where each instance (block) is drawn in layout mode. Ones under an enlarged
  // slot, or in no slot at all, are absent — they stay alive but hidden.
  const layoutPlacements = useMemo(() => {
    const placements = new Map<string, Rect>();
    if (!layoutMode) return placements;
    for (const r of layouts.resolved) {
      if (r.covered || !r.slot.blockId) continue;
      if (instanceFor(layouts.blocks, r.slot.blockId, apps)) {
        placements.set(r.slot.blockId, r.rect);
      }
    }
    return placements;
  }, [layoutMode, layouts.resolved, layouts.blocks, apps]);

  // Instances that stay mounted (alive) even when not visible, kept in
  // most-recently-used order (front = most recent). Keeping this ordered makes a
  // future eviction policy easy to add: cap the number of backgrounded instances
  // and/or drop ones that have been backgrounded past some timeout.
  //
  // An instance id is a block id; apps mode shows each app's default block, whose
  // id is the app id — so in apps mode these are just app ids.
  const [aliveAppIds, setAliveAppIds] = useState<string[]>(() => {
    const ids = initial.appId ? [initial.appId] : [];
    if (initial.detailId) ids.push(initial.detailId);
    return ids;
  });

  // An optional subordinate "detail" companion docked beside the primary app.
  const [detailAppId, setDetailAppId] = useState<string | null>(
    initial.detailId,
  );

  const activateApp = useCallback(
    (id: string) => {
      // Foregrounding a single app is an apps-mode concept.
      setMode('apps');
      setActiveAppId(id);
      setAliveAppIds((prev) => [
        id,
        ...prev.filter((existing) => existing !== id),
      ]);
      // Drop the detail companion if the newly-active app doesn't own it (or the
      // detail app itself was just promoted to primary).
      setDetailAppId((current) => {
        if (!current || current === id) return null;
        const next = apps.find((app) => app.id === id);
        return next?.detailApps?.includes(current) ? current : null;
      });
    },
    [apps],
  );

  // Instances shown in layout slots join the kept-alive set (so switching views
  // or modes doesn't reload them).
  useEffect(() => {
    if (layoutPlacements.size === 0) return;
    setAliveAppIds((prev) => {
      const added = [...layoutPlacements.keys()].filter((id) => !prev.includes(id));
      return added.length ? [...prev, ...added] : prev;
    });
  }, [layoutPlacements]);

  const openDetail = useCallback((id: string) => {
    setDetailAppId(id);
    setAliveAppIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  // Host-mediated shared context. A ref backs the synchronous getter; a set of
  // subscribers is notified on every change. It's seeded from the URL so a deep
  // link restores the selection. `contextVersion` bumps on every change so the
  // URL-writing effect re-runs.
  const sharedContextRef = useRef<SharedContext>(initial.context);
  const contextSubscribers = useRef(new Set<(context: SharedContext) => void>());
  const [contextVersion, setContextVersion] = useState(0);

  const getSharedContext = useCallback(() => sharedContextRef.current, []);
  const setSharedContext = useCallback((patch: SharedContext) => {
    sharedContextRef.current = {...sharedContextRef.current, ...patch};
    for (const listener of contextSubscribers.current) {
      listener(sharedContextRef.current);
    }
    setContextVersion((version) => version + 1);
  }, []);
  const subscribeSharedContext = useCallback(
    (listener: (context: SharedContext) => void) => {
      contextSubscribers.current.add(listener);
      // Plugins read, then subscribe, in two thread round trips; replay the
      // current context so a change landing in between isn't lost.
      listener(sharedContextRef.current);
      return () => {
        contextSubscribers.current.delete(listener);
      };
    },
    [],
  );

  const [toasts, setToasts] = useState<Toast[]>([]);
  // Commands are keyed by the contributing plugin instance so an instance
  // reloading or unmounting can cleanly replace/remove just its own entries.
  const [commandsByInstance, setCommandsByInstance] = useState<
    Map<string, CommandDescriptor[]>
  >(new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [modalLayer, setModalLayer] = useState<HTMLElement | null>(null);

  const toast = useCallback((message: string, options?: ToastOptions) => {
    const id = nextToastId++;
    const tone = options?.tone ?? 'info';
    setToasts((current) => [...current, {id, message, tone}]);
    const duration = options?.durationMs ?? 4000;
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const setCommandsForInstance = useCallback(
    (instanceId: string, commands: CommandDescriptor[]) => {
      setCommandsByInstance((current) => {
        const next = new Map(current);
        if (commands.length === 0) next.delete(instanceId);
        else next.set(instanceId, commands);
        return next;
      });
    },
    [],
  );

  // The mounted instances. Each is rendered in first-mounted order (append-only)
  // so that adding one never moves an existing iframe in the DOM (which would
  // reload it); the MRU order above is only for bookkeeping.
  const mountOrder = useRef<string[]>([]);
  for (const id of [...aliveAppIds, ...layoutPlacements.keys()]) {
    if (!mountOrder.current.includes(id)) mountOrder.current.push(id);
  }
  const mounted: Instance[] = mountOrder.current
    .filter((id) => aliveAppIds.includes(id) || layoutPlacements.has(id))
    .map((id) => instanceFor(layouts.blocks, id, apps))
    .filter((i): i is Instance => i !== null);

  // Per-instance settings broker: plugins read their settings synchronously from
  // the latest render and are pushed changes (e.g. live while authoring).
  const instancesRef = useRef(new Map<string, Instance>());
  instancesRef.current = new Map(mounted.map((i) => [i.id, i]));
  const mountedIds = mounted.map((i) => i.id);
  const settingsFeed = useInstanceFeed<BlockSettings>(
    mountedIds,
    (id) => instancesRef.current.get(id)?.settings ?? {},
  );
  const getInstanceInfo = useCallback((instanceId: string): InstanceInfo => {
    const instance = instancesRef.current.get(instanceId);
    return {
      instanceId,
      appId: instance?.app.id ?? instanceId,
      label: instance?.label ?? instanceId,
    };
  }, []);

  // Wiring broker. Each instance's latest published outputs are kept here; an
  // instance's inputs are resolved from the active view's bindings (only in
  // layout mode — apps mode has no wiring) and pushed when they change.
  // Publishing bumps `outputsVersion` to re-render, which runs the feed's diff.
  const outputsRef = useRef(new Map<string, Record<string, PortValue | null>>());
  const [, setOutputsVersion] = useState(0);
  const publishOutput = useCallback(
    (instanceId: string, output: string, value: PortValue | null) => {
      const current = outputsRef.current.get(instanceId) ?? {};
      outputsRef.current.set(instanceId, {...current, [output]: value});
      setOutputsVersion((version) => version + 1);
    },
    [],
  );
  const wiringView = layoutMode ? layouts.view : null;
  const inputsFeed = useInstanceFeed<BlockInputs>(mountedIds, (id) =>
    wiringView
      ? resolveInputs(wiringView, id, (blockId, output) => outputsRef.current.get(blockId)?.[output])
      : {},
  );

  // The palette spans the apps currently in the foreground — the primary app and
  // the open detail companion — so a composed workspace has one unified command
  // surface. Backgrounded apps stay alive but their commands aren't surfaced.
  // In layout mode, that's every app currently visible in a slot.
  const visibleAppIds = useMemo(
    () =>
      layoutMode
        ? [...layoutPlacements.keys()]
        : [activeAppId, detailAppId].filter((id): id is string => Boolean(id)),
    [layoutMode, layoutPlacements, activeAppId, detailAppId],
  );
  // When several instances of one app are visible, their commands would read
  // identically, so each is tagged with its instance's label.
  const activeCommands = useMemo(() => {
    const visible = mounted.filter((i) => visibleAppIds.includes(i.id));
    return visible.flatMap((instance) => {
      const ambiguous = visible.some(
        (other) => other !== instance && other.app.id === instance.app.id,
      );
      return (commandsByInstance.get(instance.id) ?? []).map((command) => ({
        ...command,
        id: `${instance.id}:${command.id}`,
        subtitle: ambiguous
          ? `${instance.label}${command.subtitle ? ` · ${command.subtitle}` : ''}`
          : command.subtitle,
      }));
    });
  }, [commandsByInstance, visibleAppIds, mounted]);

  // Global shortcut handling. Used both by the host's own window keydown and by
  // shortcuts forwarded from focused plugin iframes (which the host can't observe
  // directly across the origin boundary).
  const applyShortcut = useCallback(
    (event: {metaKey: boolean; ctrlKey: boolean; key: string}) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
      }
    },
    [],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
      }
      applyShortcut(event);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyShortcut]);

  // Reflect the workspace (primary app, docked detail, shared selection) into the
  // URL so it's shareable / bookmarkable / reloadable.
  useEffect(() => {
    writeWorkspaceToUrl(apps, {
      appId: activeAppId,
      detailId: detailAppId,
      context: sharedContextRef.current,
      mode,
      viewId: layouts.activeViewId,
    });
  }, [apps, activeAppId, detailAppId, contextVersion, mode, layouts.activeViewId]);

  const value = useMemo<ChromeContextValue>(
    () => ({
      toast,
      setCommandsForInstance,
      getInstanceInfo,
      getInstanceSettings: settingsFeed.get,
      subscribeInstanceSettings: settingsFeed.subscribe,
      publishOutput,
      getInstanceInputs: inputsFeed.get,
      subscribeInstanceInputs: inputsFeed.subscribe,
      apps,
      activateApp,
      getSharedContext,
      setSharedContext,
      subscribeSharedContext,
      handleForwardedShortcut: applyShortcut,
      toolbarSlot,
      modalLayer,
    }),
    [
      toast,
      setCommandsForInstance,
      getInstanceInfo,
      settingsFeed.get,
      settingsFeed.subscribe,
      publishOutput,
      inputsFeed.get,
      inputsFeed.subscribe,
      apps,
      activateApp,
      getSharedContext,
      setSharedContext,
      subscribeSharedContext,
      applyShortcut,
      toolbarSlot,
      modalLayer,
    ],
  );

  const activeApp = apps.find((app) => app.id === activeAppId);

  return (
    <ChromeContext.Provider value={value}>
      <div className={`chrome${layoutMode ? ' layout-mode' : ''}`}>
        <header className="nav">
          <div className="brand">▦ Federated Frontend</div>
          <div className="mode-toggle" role="group" aria-label="Workspace mode">
            <button
              className={!layoutMode ? 'active' : ''}
              aria-pressed={!layoutMode}
              onClick={() => {
                layouts.cancelEditing();
                setMode('apps');
              }}
            >
              Apps
            </button>
            <button
              className={layoutMode ? 'active' : ''}
              aria-pressed={layoutMode}
              onClick={() => setMode('layout')}
            >
              Layouts
            </button>
          </div>
          {/* Plugins portal toolbar sections into this slot. */}
          <div className="toolbar-slot" ref={setToolbarSlot} />
          {/* Toggles to dock a subordinate "detail" companion of the active app. */}
          {!layoutMode && activeApp?.detailApps?.map((detailId) => {
            const companion = apps.find((app) => app.id === detailId);
            if (!companion) return null;
            const open = detailAppId === detailId;
            return (
              <button
                key={detailId}
                className={`detail-toggle${open ? ' active' : ''}`}
                onClick={() => (open ? setDetailAppId(null) : openDetail(detailId))}
              >
                {open ? '▣' : '▢'} {companion.name} panel
              </button>
            );
          })}
          <button className="cmdk-button" onClick={() => setPaletteOpen(true)}>
            Search & commands <kbd>⌘K</kbd>
          </button>
        </header>

        <div className="body">
          {/* Hidden (not unmounted) in layout mode so the tree shape is stable. */}
          <nav className="app-rail" hidden={layoutMode}>
            <div className="app-rail-heading">Apps</div>
            {/* Companion (detail-only) apps are opened from the active app, not the rail. */}
            {apps
              .filter((app) => !app.detail)
              .map((app) => (
                <button
                  key={app.id}
                  className={`app-rail-item${app.id === activeAppId ? ' active' : ''}`}
                  onClick={() => activateApp(app.id)}
                >
                  <span className="app-rail-name">{app.name}</span>
                  <span className="app-rail-kind">
                    {app.kind === 'plugin' ? 'integrated' : 'external'}
                    {aliveAppIds.includes(app.id) && app.id !== activeAppId
                      ? ' · running'
                      : ''}
                  </span>
                </button>
              ))}
          </nav>

          <main className="content">
            {layoutMode && <LayoutBar layouts={layouts} />}
            {/*
              Every activated app stays mounted (kept alive) and is positioned by
              CSS — into the primary pane, the docked detail pane, a layout slot,
              or hidden — purely via class/style, never reparented, so
              iframes/threads/state survive app switches, detail open/close, view
              switches, slot swaps and enlargements. AppView renders contributions
              for any visible app, so the foreground composition drives the chrome.

              In layout mode the host-owned slot chrome (headers, pickers, edit
              handles) is a separate overlay sharing the same grid (SlotLayer).
            */}
            <div className="stage">
              <div
                className={`panes${layoutMode ? ' layout-grid' : detailAppId ? ' has-detail' : ''}`}
                style={
                  layoutMode
                    ? gridTemplate(layouts.view.cols, layouts.view.rows)
                    : undefined
                }
              >
                {mounted.map((instance) => {
                  const rect = layoutPlacements.get(instance.id);
                  const role = layoutMode
                    ? rect
                      ? 'slot'
                      : 'hidden'
                    : instance.id === activeAppId
                      ? 'primary'
                      : instance.id === detailAppId
                        ? 'detail'
                        : 'hidden';
                  return (
                    <section
                      key={instance.id}
                      className={`pane pane-${role}`}
                      style={rect ? {gridArea: gridArea(rect)} : undefined}
                    >
                      <AppView
                        instance={instance}
                        active={role !== 'hidden'}
                        subordinate={role === 'detail'}
                      />
                    </section>
                  );
                })}
              </div>
              {layoutMode && <SlotLayer layouts={layouts} apps={apps} />}
            </div>
          </main>
        </div>

        <ToastRegion toasts={toasts} />
        {paletteOpen && (
          <CommandPalette
            commands={activeCommands}
            onClose={() => setPaletteOpen(false)}
          />
        )}
        {/* Full-window overlay layer plugins portal modals into. */}
        <div className="modal-layer" ref={setModalLayer} />
      </div>
    </ChromeContext.Provider>
  );
}

function ToastRegion({toasts}: {toasts: Toast[]}) {
  return (
    <div className="toast-region">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

function CommandPalette({
  commands,
  onClose,
}: {
  commands: CommandDescriptor[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.subtitle?.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const run = useCallback(
    async (command: CommandDescriptor | undefined) => {
      if (!command) return;
      onClose();
      // `run` lives in the plugin; this invocation is proxied across the
      // iframe boundary by @quilted/threads.
      await command.run();
    },
    [onClose],
  );

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void run(filtered[active]);
          }
        }}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command contributed by a plugin…"
          value={query}
          onInput={(e) => {
            // Preact: onInput fires per keystroke (onChange is the native change
            // event — blur only).
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
        />
        <ul className="palette-list">
          {filtered.length === 0 && (
            <li className="palette-empty">No commands</li>
          )}
          {filtered.map((command, index) => (
            <li
              key={command.id}
              className={`palette-item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => void run(command)}
            >
              <span className="palette-item-title">{command.title}</span>
              {command.subtitle && (
                <span className="palette-item-subtitle">{command.subtitle}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
