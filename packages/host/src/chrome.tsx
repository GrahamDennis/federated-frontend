import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CommandDescriptor,
  SharedContext,
  ToastOptions,
  ToastTone,
} from '@ff/protocol';
import type {AppDescriptor} from './apps';
import {AppView} from './AppView';

/**
 * The host chrome's shared services. Plugin hosts get at these (via {@link useChrome})
 * to fulfil the capability API, and the host-side remote components use the portal
 * targets to teleport plugin-contributed UI into the chrome.
 */
interface ChromeContextValue {
  toast(message: string, options?: ToastOptions): void;
  /** Replace the command-palette entries contributed by one plugin. */
  setCommandsForPlugin(pluginId: string, commands: CommandDescriptor[]): void;
  /** All registered apps (so a plugin can be offered its siblings). */
  apps: AppDescriptor[];
  /** Bring an app to the foreground. */
  activateApp(appId: string): void;
  /** Shared workspace context (broker for composing apps around one selection). */
  getSharedContext(): SharedContext;
  setSharedContext(patch: SharedContext): void;
  subscribeSharedContext(listener: (context: SharedContext) => void): () => void;
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
  const [activeAppId, setActiveAppId] = useState(apps[0]?.id);

  // Apps that stay mounted (alive) even when not visible, kept in
  // most-recently-used order (front = most recent). Keeping this ordered makes a
  // future eviction policy easy to add: cap the number of backgrounded apps
  // and/or drop ones that have been backgrounded past some timeout.
  const [aliveAppIds, setAliveAppIds] = useState<string[]>(() =>
    apps[0] ? [apps[0].id] : [],
  );

  // An optional subordinate "detail" companion docked beside the primary app.
  const [detailAppId, setDetailAppId] = useState<string | null>(null);

  const activateApp = useCallback(
    (id: string) => {
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

  const openDetail = useCallback((id: string) => {
    setDetailAppId(id);
    setAliveAppIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  // Host-mediated shared context. A ref backs the synchronous getter; a set of
  // subscribers is notified on every change.
  const sharedContextRef = useRef<SharedContext>({});
  const contextSubscribers = useRef(new Set<(context: SharedContext) => void>());

  const getSharedContext = useCallback(() => sharedContextRef.current, []);
  const setSharedContext = useCallback((patch: SharedContext) => {
    sharedContextRef.current = {...sharedContextRef.current, ...patch};
    for (const listener of contextSubscribers.current) {
      listener(sharedContextRef.current);
    }
  }, []);
  const subscribeSharedContext = useCallback(
    (listener: (context: SharedContext) => void) => {
      contextSubscribers.current.add(listener);
      return () => {
        contextSubscribers.current.delete(listener);
      };
    },
    [],
  );

  const [toasts, setToasts] = useState<Toast[]>([]);
  // Commands are keyed by the contributing plugin so a plugin reloading or
  // unmounting can cleanly replace/remove just its own entries.
  const [commandsByPlugin, setCommandsByPlugin] = useState<
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

  const setCommandsForPlugin = useCallback(
    (pluginId: string, commands: CommandDescriptor[]) => {
      setCommandsByPlugin((current) => {
        const next = new Map(current);
        if (commands.length === 0) next.delete(pluginId);
        else next.set(pluginId, commands);
        return next;
      });
    },
    [],
  );

  // The palette spans the apps currently in the foreground — the primary app and
  // the open detail companion — so a composed workspace has one unified command
  // surface. Backgrounded apps stay alive but their commands aren't surfaced.
  const visibleAppIds = useMemo(
    () => [activeAppId, detailAppId].filter((id): id is string => Boolean(id)),
    [activeAppId, detailAppId],
  );
  const activeCommands = useMemo(
    () => visibleAppIds.flatMap((id) => commandsByPlugin.get(id) ?? []),
    [commandsByPlugin, visibleAppIds],
  );

  // Global Cmd/Ctrl-K toggles the command palette.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo<ChromeContextValue>(
    () => ({
      toast,
      setCommandsForPlugin,
      apps,
      activateApp,
      getSharedContext,
      setSharedContext,
      subscribeSharedContext,
      toolbarSlot,
      modalLayer,
    }),
    [
      toast,
      setCommandsForPlugin,
      apps,
      activateApp,
      getSharedContext,
      setSharedContext,
      subscribeSharedContext,
      toolbarSlot,
      modalLayer,
    ],
  );

  const activeApp = apps.find((app) => app.id === activeAppId);

  return (
    <ChromeContext.Provider value={value}>
      <div className="chrome">
        <header className="nav">
          <div className="brand">▦ Federated Frontend</div>
          {/* Plugins portal toolbar sections into this slot. */}
          <div className="toolbar-slot" ref={setToolbarSlot} />
          {/* Toggles to dock a subordinate "detail" companion of the active app. */}
          {activeApp?.detailApps?.map((detailId) => {
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
          <nav className="app-rail">
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
            {/*
              Every activated app stays mounted (kept alive) and is positioned by
              CSS into the primary pane, the docked detail pane, or hidden — purely
              via a class, never reparented, so iframes/threads/state survive both
              switches and detail open/close. AppView renders contributions for any
              visible app (primary or detail), so the foreground composition drives
              the chrome.
            */}
            <div className={`panes${detailAppId ? ' has-detail' : ''}`}>
              {apps
                .filter((app) => aliveAppIds.includes(app.id))
                .map((app) => {
                  const role =
                    app.id === activeAppId
                      ? 'primary'
                      : app.id === detailAppId
                        ? 'detail'
                        : 'hidden';
                  return (
                    <section key={app.id} className={`pane pane-${role}`}>
                      <AppView
                        app={app}
                        active={role !== 'hidden'}
                        subordinate={role === 'detail'}
                      />
                    </section>
                  );
                })}
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
          onChange={(e) => {
            setQuery(e.target.value);
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
