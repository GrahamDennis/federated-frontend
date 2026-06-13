import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {createPortal} from 'react-dom';
import type {CommandDescriptor, ToastOptions, ToastTone} from '@ff/protocol';
import {
  PlatformProvider,
  type ComponentKit,
  type Platform,
} from './platform';

/**
 * Standalone mode. With no host chrome to talk to, the plugin renders its own
 * minimal chrome (toast region, ⌘K command palette, whole-window modal layer,
 * and a header toolbar) so that nearly all of its functionality still works.
 * Host-only capabilities (switching to a sibling app) are simply absent.
 */

// ---- standalone store (toasts + commands surfaced by the plugin's own chrome) ----

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface StandaloneState {
  toasts: ToastItem[];
  commands: CommandDescriptor[];
}

let state: StandaloneState = {toasts: [], commands: []};
const listeners = new Set<() => void>();
let nextToastId = 1;

function emit() {
  for (const listener of listeners) listener();
}

export const standaloneStore = {
  toast(message: string, options?: ToastOptions) {
    const id = nextToastId++;
    state = {
      ...state,
      toasts: [...state.toasts, {id, message, tone: options?.tone ?? 'info'}],
    };
    emit();
    window.setTimeout(() => {
      state = {...state, toasts: state.toasts.filter((t) => t.id !== id)};
      emit();
    }, options?.durationMs ?? 4000);
  },
  setCommands(commands: CommandDescriptor[]) {
    state = {...state, commands};
    emit();
  },
};

function useStandaloneState<T>(selector: (state: StandaloneState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
    () => selector(state),
  );
}

// ---- chrome slot context (so the kit's Toolbar/Modal can portal into the chrome) ----

interface ChromeSlots {
  toolbarSlot: HTMLElement | null;
  modalLayer: HTMLElement | null;
}

const ChromeSlotContext = createContext<ChromeSlots>({
  toolbarSlot: null,
  modalLayer: null,
});

// ---- local component kit ----

function Stack({
  direction = 'vertical',
  gap = 8,
  children,
}: {
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction === 'horizontal' ? 'row' : 'column',
        gap,
        alignItems: direction === 'horizontal' ? 'center' : 'stretch',
      }}
    >
      {children}
    </div>
  );
}

function Text({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'subdued';
  children?: ReactNode;
}) {
  return (
    <span style={{color: tone === 'subdued' ? '#5a626c' : 'inherit'}}>
      {children}
    </span>
  );
}

function Button({
  tone = 'default',
  disabled = false,
  onPress,
  children,
}: {
  tone?: 'default' | 'primary' | 'critical';
  disabled?: boolean;
  onPress?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      className={`btn btn-${tone}`}
      disabled={disabled}
      onClick={() => onPress?.()}
    >
      {children}
    </button>
  );
}

function Toolbar({label, children}: {label?: string; children?: ReactNode}) {
  const {toolbarSlot} = useContext(ChromeSlotContext);
  if (!toolbarSlot) return null;
  return createPortal(
    <div className="sa-toolbar-section">
      {label && <span className="sa-toolbar-label">{label}</span>}
      {children}
    </div>,
    toolbarSlot,
  );
}

function Modal({
  open = false,
  heading,
  onClose,
  children,
}: {
  open?: boolean;
  heading?: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const {modalLayer} = useContext(ChromeSlotContext);
  if (!open || !modalLayer) return null;
  return createPortal(
    <div className="sa-modal-backdrop" onClick={() => onClose?.()}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <header className="sa-modal-header">
          <h2>{heading}</h2>
          <button className="sa-modal-close" onClick={() => onClose?.()}>
            ×
          </button>
        </header>
        <div className="sa-modal-body">{children}</div>
      </div>
    </div>,
    modalLayer,
  );
}

const standaloneKit: ComponentKit = {Stack, Text, Button, Toolbar, Modal};

export function createStandalonePlatform(): Platform {
  return {
    mode: 'standalone',
    toast: (message, options) => standaloneStore.toast(message, options),
    setCommands: (commands) => standaloneStore.setCommands(commands),
    components: standaloneKit,
    // listApps / switchApp deliberately omitted: there's no surrounding shell.
  };
}

// ---- the plugin's own chrome ----

export function StandaloneChrome({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const [modalLayer, setModalLayer] = useState<HTMLElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toasts = useStandaloneState((s) => s.toasts);

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

  const slots = useMemo(() => ({toolbarSlot, modalLayer}), [toolbarSlot, modalLayer]);

  return (
    <PlatformProvider value={platform}>
      <ChromeSlotContext.Provider value={slots}>
        <div className="sa-shell">
          <header className="sa-nav">
            <div className="sa-brand">
              📝 Example Notes
              <span className="sa-badge">standalone</span>
            </div>
            <div className="sa-toolbar-slot" ref={setToolbarSlot} />
            <button className="sa-cmdk" onClick={() => setPaletteOpen(true)}>
              Commands <kbd>⌘K</kbd>
            </button>
          </header>

          <main className="sa-content">{children}</main>

          <div className="sa-toast-region">
            {toasts.map((t) => (
              <div key={t.id} className={`sa-toast sa-toast-${t.tone}`}>
                {t.message}
              </div>
            ))}
          </div>

          {paletteOpen && (
            <CommandPalette onClose={() => setPaletteOpen(false)} />
          )}
          <div className="sa-modal-layer" ref={setModalLayer} />
        </div>
      </ChromeSlotContext.Provider>
    </PlatformProvider>
  );
}

function CommandPalette({onClose}: {onClose: () => void}) {
  const commands = useStandaloneState((s) => s.commands);
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

  async function run(command: CommandDescriptor | undefined) {
    if (!command) return;
    onClose();
    await command.run();
  }

  return (
    <div className="sa-palette-backdrop" onClick={onClose}>
      <div
        className="sa-palette"
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
          className="sa-palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul className="sa-palette-list">
          {filtered.length === 0 && (
            <li className="sa-palette-empty">No commands</li>
          )}
          {filtered.map((command, index) => (
            <li
              key={command.id}
              className={`sa-palette-item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => void run(command)}
            >
              <span className="sa-palette-item-title">{command.title}</span>
              {command.subtitle && (
                <span className="sa-palette-item-subtitle">
                  {command.subtitle}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
