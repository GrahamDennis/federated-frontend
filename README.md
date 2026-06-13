# Federated Frontend — prototype

A prototype of an application shell ("chrome") that hosts untrusted third-party
**plugins** in sandboxed cross-origin iframes, and lets those plugins contribute
UI that escapes their iframe — toasts, a command palette, whole-window modals,
and toolbar controls — through two complementary, capability-style channels.

## The core idea

An iframe is confined to its rectangle and, with `sandbox` + a separate origin,
can't touch the host. So a plugin can never *draw* a whole-window popover itself.
Instead it **describes** what it wants and the **host renders it**. There are two
ways to do that, and the prototype uses both for the jobs each is best at:

| Channel | Library | Used for | Why |
|---|---|---|---|
| **Capability RPC** | [`@quilted/threads`](https://github.com/lemonmade/quilt/tree/main/packages/threads) | `toast(...)`, `setCommands(...)` | Imperative / data-only or callback-driven actions. The host renders its own native UI; the plugin just calls a method. |
| **Component contribution** | [`remote-dom`](https://github.com/Shopify/remote-dom) | toolbar section, whole-window modal | Declarative component *trees*. The plugin builds an inert element tree; the host maps each element to its own React component and decides **where** it renders (via React portals it lands in the nav / a window overlay). |

`remote-dom` is built on `@quilted/threads`, so a single postMessage transport
carries both channels. `@quilted/threads` proxies functions across the boundary,
which is what makes command `run` callbacks and remote-dom event listeners
(`onPress`, `onClose`) work.

## Layout

```
packages/
  protocol/         Shared contract: HostThread API + the remote-dom "component kit"
                    (tag names, properties, events) both sides agree on.
  host/    :5173    The chrome. App rail (switcher), nav, command palette (⌘K),
                    toast region, modal layer, the active app's iframe container, and
                    the host-side component kit (RemoteRootRenderer + component map).
  plugin-example/   :5174  An untrusted plugin. Its own in-iframe UI, plus a contributed
                    remote-dom tree (toolbar + modal) and two ⌘K commands.
```

The host and plugin run on **different origins** (`:5173` vs `:5174`) so the
iframe boundary is a real security boundary, not just a visual frame.

### Multiple apps

The chrome hosts a registry of apps (`host/src/apps.ts`) and switches between them
via the left app rail. Two kinds:

- **`plugin`** — integrated, loaded via `PluginHost` (thread + remote-dom).
- **`external`** — a plain sandboxed iframe with no host integration (e.g. Google).

Apps are **kept alive**: once activated, an app stays mounted and is merely hidden
when another app is foregrounded, so its iframe, thread, and state survive
switches (no reload, no re-handshake). What's scoped to the active app are the
*contributions*: a backgrounded plugin keeps running, but its toolbar section,
command-palette entries, and modal are only surfaced while it's in the foreground
(`PluginHost` mounts the `RemoteRootRenderer` only when `active`; the chrome shows
only the active app's commands). **Toasts are the deliberate exception** — a
backgrounded app can still raise one, which is much of the point of keeping it
alive. The app rail (`aliveAppIds`) is kept in most-recently-used order so a future
policy can cap the number of backgrounded apps and/or evict ones idle past a
timeout.

The host chrome (nav + app rail) renders **above** plugin-contributed modals, so
an untrusted plugin can't cover the whole window and trap the user — they can
always switch apps or open ⌘K.

> The Google entry uses `https://www.google.com/webhp?igu=1`. Plain
> `https://google.com` refuses to be framed (`X-Frame-Options` / CSP
> `frame-ancestors`); `igu=1` is Google's frameable embed endpoint.

## Run it

```bash
npm install
npm run dev       # starts host (:5173) and plugin (:5174) together
# open http://localhost:5173
npm run typecheck
npm test          # Playwright e2e (boots both servers automatically)
```

Try: the **Open details / Quick save** buttons in the top nav (contributed by the
plugin via remote-dom), **⌘K** for the plugin's commands, and the buttons inside
the iframe panel.

## Tests

End-to-end tests in `tests/` use `@playwright/test` and drive the real chrome,
exercising the cross-origin channels rather than mocking them:

- `tests/remote-dom.spec.ts` — toolbar contribution renders in the host nav;
  `press`/`close` events round-trip; the modal is rendered by the host (not the
  iframe) and covers the window; shared modal state stays in sync between the
  in-iframe UI and the chrome.
- `tests/capability-api.spec.ts` — toast from inside the iframe; command-palette
  registration; command `run` callbacks proxied back to the plugin; query
  filtering; the ⌘K shortcut.
- `tests/app-switching.spec.ts` — the app rail lists every app; backgrounding a
  plugin hides it and its contributions (but keeps it alive/running); switching
  back restores them; and a backgrounded plugin keeps its state across switches.

The Playwright config (`playwright.config.ts`) auto-starts both dev servers via
`webServer`, so `npm test` is self-contained. It drives the locally installed
Google Chrome through the `chrome` channel — no Playwright browser download is
needed. The `tests/fixtures.ts` `connectedPage` fixture gates every test on the
plugin's threads + remote-dom handshake completing.

```bash
npm test            # headless run
npm run test:ui     # interactive Playwright UI
```

## How the connection is set up (and why the plugin initiates)

1. The host creates the iframe and immediately constructs a `ThreadWindow`, so it
   is *listening* before the plugin finishes loading.
2. The plugin loads, constructs its `ThreadWindow.parent`, and **pulls** the
   host's remote-dom connection via `host.connect()`. `@quilted/threads` has no
   built-in handshake, and a `postMessage` sent before the other side attaches a
   listener is lost — so the side that loads last (the plugin) sends first.
3. The plugin attaches a `RemoteMutationObserver` to its contributed tree and
   registers commands / fires toasts over the same thread.

## Notable decisions / caveats

- **`@remote-dom/react` is optional.** `@remote-dom/core` is framework-agnostic;
  the React bindings are just for JSX ergonomics. `@remote-dom/react` pulls in
  `@types/react@18`, so the root `package.json` has an `overrides` block pinning a
  single `@types/react@19` to avoid duplicate-React-types errors.
- **`StrictMode` is intentionally omitted** in the host — its dev-only double
  invocation of effects would tear down and recreate the iframe/thread mid-handshake.
- **Sandbox**: `allow-scripts allow-same-origin`. `allow-same-origin` gives the
  iframe *its own* origin (`:5174`), not the host's; since that differs from the
  host origin, the two remain isolated by the browser while still allowing targeted
  `postMessage`.
- This is a prototype: the app registry is hardcoded, there's no per-plugin CSP or
  auth, and every activated app is kept alive indefinitely (no eviction yet). See
  "Next steps" below.

## Next steps (not implemented)

- A real plugin registry / manifest and dynamic loading.
- Per-plugin Content-Security-Policy and permission scoping of the capability API.
- More contributed surfaces (sidebars, settings panels, context menus).
- A keep-alive eviction policy: cap the number of backgrounded apps and evict the
  least-recently-used / longest-idle ones (the `aliveAppIds` MRU list is the hook).
