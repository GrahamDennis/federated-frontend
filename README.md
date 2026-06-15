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
  protocol/         Framework- AND transport-agnostic wire contract: HostThread API,
                    the remote-dom element definitions both sides agree on, origins,
                    and transport-agnostic helpers. No React, no @quilted/threads import.
  plugin-sdk-react/ React plugin SDK layered on protocol: connectToHost (the threads
                    handshake), the Platform abstraction + ComponentKit, the hosted/
                    standalone kits, and StandaloneChrome.
  host/    :5173    The chrome. App rail (switcher), nav, command palette (⌘K),
                    toast region, modal layer, the active app's iframe container, and
                    the host-side component kit (RemoteRootRenderer + component map).
  plugin-example/   :5174  An untrusted plugin. Its own in-iframe UI, plus a contributed
                    remote-dom tree (toolbar + modal) and two ⌘K commands.
  plugin-map/       :5175  A MapLibre GL map plugin. Uses only the capability API
                    (⌘K fly-to commands + toasts) — no remote-dom contributions.
  plugin-places/    :5176  A subordinate "detail" companion that reflects/annotates
                    the place selected in the shared workspace context.
  plugin-registry/  :5180  Plugin distribution + discovery. Packages plugins as
                    ORAS-style OCI artifacts and serves them: a dumb
                    content-addressed endpoint (/content/<repo>@<digest>/) plus a
                    discovery API (/v1/plugins). The host discovers all its apps
                    here — it hardcodes no individual plugin. See its README.
```

The host and plugin run on **different origins** (`:5173` vs `:5174`) so the
iframe boundary is a real security boundary, not just a visual frame.

### Different frameworks per app: the host is Preact, the plugins are React 19

To prove the apps needn't share a framework (or a framework *version*), the **host
runs on Preact** while the **plugins author their trees in React 19**. They
interoperate purely through the framework-agnostic remote-dom connection: the
plugin (React) streams DOM mutations across the iframe boundary, and the host
(Preact) renders them with its own Preact components via `@remote-dom/preact`'s
`SignalRemoteReceiver` + `RemoteRootRenderer`. The host has **no React dependency
and no `react → preact/compat` alias** (the "shim"); JSX uses Preact's automatic
runtime (`jsxImportSource: 'preact'`, no `@vitejs/plugin-react`).

A few Preact-specific things this surfaced:

- **Portals** live in `preact/compat`; to stay shim-free the host hand-rolls a
  tiny portal (`remoteComponents.tsx`) that renders into the chrome's leaf slots.
- **`onChange` is the native change event** in Preact (fires on blur), so the
  command palette input uses **`onInput`** to filter as you type.
- **`@remote-dom/preact`'s renderer is signals-based**: the host must `import
  '@preact/signals'` (side effect) to activate the Preact integration so renders
  track the receiver's signals, and Vite `resolve.dedupe`s preact + signals so
  there's a single instance.

### Hosted vs standalone (progressive enhancement)

The example plugin also runs **standalone** — open http://localhost:5174 directly.
On boot it detects its environment: if it's top-level it's standalone; if it's
framed it attempts the threads handshake and falls back to standalone if no host
answers (so it survives being embedded by an unrelated page too).

The plugin's feature code is written once against a `Platform` abstraction
(`plugin-example/src/platform.tsx`): `toast`, `setCommands`, a component kit
(`Toolbar`/`Modal`/`Button`/`Stack`/`Text`), and *optional* host-only
capabilities. Two implementations:

- **hosted** (`kit-hosted.tsx`) — the kit is remote-dom elements rendered by the
  host; `toast`/`setCommands` go over threads.
- **standalone** (`kit-standalone.tsx`) — the plugin renders its **own** minimal
  chrome (toast region, ⌘K palette, whole-window modal layer, header toolbar) so
  nearly everything still works.

What's **not** possible standalone is modelled as optional capabilities that are
simply absent: e.g. `switchApp`/`listApps` (asking the shell to foreground a
sibling app) only exist when hosted, and the UI feature-detects them and degrades
gracefully.

### Multiple apps

The chrome hosts a registry of apps (`host/src/apps.ts`) and switches between them
via the left app rail. Two kinds:

- **`plugin`** — integrated, loaded via `PluginHost` (thread + remote-dom).
- **`external`** — a plain sandboxed iframe with no host integration (e.g. Google).

The registry ships three: **Example Notes** (remote-dom + capability API), **World
Map** (a MapLibre GL map that uses *only* the capability API — ⌘K fly-to commands
and toasts, no remote-dom), and **Google** (external).

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

### Composed workspaces: shared context + a detail companion

This is the part that justifies a chrome over native tabs — composing multiple
apps around the *same data*. The host exposes a domain-agnostic **shared context**
broker (`getContext` / `setContext` / `subscribeContext` on `HostThread`): it
stores a bag and broadcasts changes; the apps agree on its shape.

The **World Map** (hub) publishes the selected place to the context; the
**Places** panel (a `detail`-only companion, hidden from the rail) subscribes and
reflects/annotates it, and can clear it back — bidirectional, across two separate
cross-origin iframes. Activate the map and toggle **Places panel** in the nav to
dock it as a subordinate pane:

- **Layout** — a two-pane grid (`primary | detail`). Every kept-alive app is a
  grid child positioned purely by class (`pane-primary` / `pane-detail` /
  `pane-hidden`), never reparented, so switching apps and opening/closing the
  detail panel never reloads an iframe.
- **Unified palette** — ⌘K spans the apps currently in the foreground (primary +
  detail), so the composed workspace has one command surface (e.g. the map's
  fly-to commands and the Places "Clear selection" command together).

A `detail` app declares nothing special; the parent lists it in `detailApps`. The
companion still runs standalone (open http://localhost:5176) — it just has no
shared selection to reflect, and says so.

### URL-addressable workspaces

The workspace is encoded in the host URL, so a composed view is shareable /
bookmarkable / reloadable — augmenting browser tabs rather than replacing them:

```
http://localhost:5173/?app=world-map&detail=places&ctx=<url-encoded JSON context>
```

The host owns the top-level URL (plugins are cross-origin iframes and can't touch
it). On load it parses `app` / `detail` / `ctx` and seeds the chrome state + shared
context (so apps that connect get the restored selection from `getContext()`); on
every change it `replaceState`s the URL (`host/src/workspaceUrl.ts`). The default
app and an empty context are omitted to keep URLs clean. The shared context is
round-tripped as opaque JSON so the host stays domain-agnostic — and the map flies
from the selection's own coordinates, so a deep-linked place need not be in its
catalog.

> The Google entry uses `https://www.google.com/webhp?igu=1`. Plain
> `https://google.com` refuses to be framed (`X-Frame-Options` / CSP
> `frame-ancestors`); `igu=1` is Google's frameable embed endpoint.

## Plugin distribution & discovery

The chrome hardcodes **no individual plugin**. It discovers what to host at boot
from a small companion service, **`@ff/plugin-registry`** (`:5180`), and the host's
only configuration is where that registry lives (`VITE_PLUGIN_REGISTRY_URL`). The
service has two responsibilities behind one shared resolver
(`packages/plugin-registry/`):

- **Discovery** — `GET /v1/plugins?<filters>` returns each configured plugin's
  manifest plus an **immutable** content URL. The host fetches this and builds its
  app rail (`host/src/apps.ts`); it can filter by `kind` etc. rather than naming
  plugins.
- **Content** — `GET /content/<repo>@<digest>/<path>` serves a plugin's unpacked
  static bundle. It's content-addressed (immutable, long-cached) and the URL is
  the artifact's own OCI coordinate, so it's self-documenting (which plugin) and
  self-locating (where to pull) — e.g.
  `…/content/ff-plugins/world-map@sha256:76bb…/index.html`.

A plugin is distributed as an **ORAS-style OCI artifact**: the unpacked `dist/`
bundle plus a manifest (`ff-plugin.json`, authored in each plugin's `public/`,
lifted into the artifact's config blob). The registry is configured with **plugin
sources** — `oci` (an artifact, referenced by a moving tag that's resolved to an
immutable digest at query time so the tag never reaches the host, or pinned by
`@sha256`), `http` (an already-unpacked bundle at a URL — a CDN, object store, or
a Vite dev server), or `external` (an arbitrary embedded site, e.g. Google). This
is what lets the **same host** run against either dev servers or deployed
artifacts: in dev the registry points at the plugin dev servers, so `npm run dev`
works end-to-end without an OCI registry; the deployed path serves the exact same
plugins from content-addressed artifacts (see `packages/plugin-registry/README.md`).

Extracted bundles are cached on disk and bounded by eviction: the currently
configured plugins are pinned, everything else (old versions, removed plugins)
ages out by TTL / LRU size cap.

## Run it

```bash
npm install
npm run dev       # host (:5173), plugin registry (:5180), and the 3 plugins (:5174–:5176)
# open http://localhost:5173
npm run typecheck
npm test          # Playwright e2e (boots all the dev servers automatically)
```

The host discovers its apps from the plugin registry (`:5180`), which in dev is
backed by the plugin dev servers — so no OCI registry is needed for the dev loop.
To exercise the **deployed** path (plugins served from an OCI registry as
content-addressed artifacts), see `packages/plugin-registry/README.md`: run a
local zot, `oras push` the plugins, and point a source at `type: oci`.

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
  back restores them; a backgrounded plugin keeps its state across switches; and a
  hosted plugin can ask the shell to switch to a sibling app.
- `tests/standalone.spec.ts` — loading the plugin directly: it detects standalone
  mode and its own chrome, toasts/modal/command-palette all work, and the
  host-only "switch app" capability is correctly unavailable.
- `tests/map.spec.ts` — the MapLibre plugin hosted (renders, detects hosted, flying
  raises a host toast, registers per-app ⌘K commands) and standalone (map + controls
  still work, no host required).
- `tests/shared-context.spec.ts` — docking the Places detail panel beside the map;
  a map selection reflecting in Places and a Places "clear" propagating back; the
  ⌘K palette spanning both composed apps; Places standalone.
- `tests/shortcuts.spec.ts` — ⌘K opens the palette and Escape closes it even while
  a cross-origin plugin iframe has focus (forwarded over the thread).
- `tests/routing.spec.ts` — a deep link restores app + docked detail + selection;
  switching apps, selecting a place, and docking the detail panel each update the
  URL; the default app is omitted for clean URLs.

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
- **Package layering / what goes where.** `@ff/protocol` imports *neither* a UI
  framework *nor* a concrete transport — it's the pure wire contract (types, remote
  element definitions, origins, and transport-agnostic helpers like
  `forwardKeyboardShortcuts`, written against an abstract host). Anything that
  imports React *or* `@quilted/threads` lives one layer up in `@ff/plugin-sdk-react`
  — including `connectToHost` (it imports `ThreadWindow`, so it's transport-specific
  even though it's React-free). Plugins that render their own UI (map, Places)
  import just `@ff/plugin-sdk-react/connect`; the example plugin uses the full SDK.
  Internal workspace packages are consumed as TS source (no build step); Vite
  transforms their TSX, and `@ff/plugin-sdk-react` declares no React dependency so
  it resolves each consumer's hoisted React.
- **`StrictMode` is intentionally omitted** in the host — its dev-only double
  invocation of effects would tear down and recreate the iframe/thread mid-handshake.
- **Contributions are declarative.** A plugin streams its remote-dom tree to the
  host via a `<RemoteContributions>` React component whose effect observes on mount
  and `disconnect({empty: true})`s on unmount, and registers its ⌘K commands in an
  effect too. Tying this to React's lifecycle (rather than an imperative
  `createRoot` + `observe` at module scope) is what keeps HMR / Fast Refresh from
  stacking duplicate toolbars — the old tree is torn out before a new one mounts.
- **`@quilted/threads` gotcha:** an imports proxy has no `then` guard, so never
  return it bare from an `async` function — `Promise.resolve` will thenable-check
  it, accessing `.then` and firing a phantom remote `then()` call. Wrap it (e.g.
  `return {host}`) or nest it inside a plain object.
- **Global shortcuts require plugin cooperation.** A cross-origin iframe is a hard
  boundary — keystrokes inside it don't reach the host, so ⌘K wouldn't open the
  palette while a plugin is focused. Plugins relay shortcuts via
  `forwardKeyboardShortcuts(host)` (one call after connecting) → `host.forwardKeydown`
  → the same handler the host's own window listener uses. Only chord shortcuts
  (⌘/Ctrl) and Escape are forwarded — never ordinary typing — so the host can't
  keylog the plugin, and nothing is `preventDefault`ed so the plugin's own ⌘C/⌘V
  keep working.
- **Sandbox**: `allow-scripts allow-same-origin`. `allow-same-origin` gives the
  iframe *its own* origin (`:5174`), not the host's; since that differs from the
  host origin, the two remain isolated by the browser while still allowing targeted
  `postMessage`.
- This is a prototype: there's no per-plugin CSP or auth, and every activated app
  is kept alive indefinitely (no eviction yet). See "Next steps" below.

## Next steps (not implemented)

- Per-plugin origin isolation for OCI-served plugins (today they share the content
  server's origin; a production setup would serve each digest from its own
  subdomain). Per-plugin Content-Security-Policy and permission scoping of the
  capability API.
- More contributed surfaces (sidebars, settings panels, context menus).
- A keep-alive eviction policy: cap the number of backgrounded apps and evict the
  least-recently-used / longest-idle ones (the `aliveAppIds` MRU list is the hook).
