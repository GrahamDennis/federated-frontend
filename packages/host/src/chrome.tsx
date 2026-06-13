import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {CommandDescriptor, ToastOptions, ToastTone} from '@ff/protocol';
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

  const activateApp = useCallback((id: string) => {
    setActiveAppId(id);
    setAliveAppIds((prev) => [id, ...prev.filter((existing) => existing !== id)]);
  }, []);

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

  // Only the active app contributes to the palette. Backgrounded apps stay alive
  // (their thread keeps running) but their commands aren't surfaced until they're
  // foregrounded again.
  const activeCommands = useMemo(
    () => (activeAppId ? (commandsByPlugin.get(activeAppId) ?? []) : []),
    [commandsByPlugin, activeAppId],
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
    () => ({toast, setCommandsForPlugin, toolbarSlot, modalLayer}),
    [toast, setCommandsForPlugin, toolbarSlot, modalLayer],
  );

  return (
    <ChromeContext.Provider value={value}>
      <div className="chrome">
        <header className="nav">
          <div className="brand">▦ Federated Frontend</div>
          {/* Plugins portal toolbar sections into this slot. */}
          <div className="toolbar-slot" ref={setToolbarSlot} />
          <button className="cmdk-button" onClick={() => setPaletteOpen(true)}>
            Search & commands <kbd>⌘K</kbd>
          </button>
        </header>

        <div className="body">
          <nav className="app-rail">
            <div className="app-rail-heading">Apps</div>
            {apps.map((app) => (
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
              Every app that has ever been activated stays mounted (kept alive),
              and is simply hidden while another app is in the foreground — so its
              iframe, thread and state survive switches. Rendered in registry order
              so panes never reorder in the DOM. AppView gates the *contributions*
              (toolbar/modal) on `active`, so a backgrounded plugin keeps running
              without cluttering the chrome.
            */}
            {apps
              .filter((app) => aliveAppIds.includes(app.id))
              .map((app) => (
                <div
                  key={app.id}
                  className="workspace"
                  hidden={app.id !== activeAppId}
                >
                  {app.description && (
                    <p className="workspace-hint">{app.description}</p>
                  )}
                  <AppView app={app} active={app.id === activeAppId} />
                </div>
              ))}
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
