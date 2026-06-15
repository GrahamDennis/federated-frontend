# @ff/plugin-registry — plugin distribution + discovery (prototype)

Distributes federated-frontend plugins as **ORAS-style OCI artifacts** and serves
them to host applications. One process, two responsibilities behind a shared
source resolver:

- **Content (dumb, content-addressed):** `GET /content/<repo>@<digest>/<path>`
  serves a file from the unpacked bundle identified by an OCI manifest `<digest>`.
  The `<repo>` is the artifact's own coordinate, so the URL is self-documenting
  (which plugin) and self-locating — the registry to pull from is looked up from
  config by repo. It knows nothing about tags, so responses are immutable
  (`Cache-Control: immutable`). Example:
  `/content/ff-plugins/world-map@sha256:76bb…/index.html`.
- **Discovery:** `GET /v1/plugins?<filters>` returns each configured plugin's
  manifest plus an **immutable** content URL. For OCI-by-tag sources the tag is
  resolved to a digest at query time and a `/content/<repo>@<digest>/` URL is
  minted, so the moving tag never reaches the host. For CDN sources the configured
  immutable URL is returned unchanged.

Combining them is deliberate: both halves need the same thing — the source list
and the tag→digest resolver. The content endpoint takes the repo straight from
the request URL, so it keeps no digest→repo index; it only maps a configured repo
to its registry host, which doubles as the safety allowlist (unconfigured repos
are refused, so it can't be used as an open pull-proxy).

## What a plugin is on the wire

A plugin = its unpacked static bundle (`dist/`) + a **manifest** authored as
`ff-plugin.json` at the plugin root (the single source of truth). The packaging
step copies it into the bundle and also lifts it into the artifact's **config
blob**, so discovery can read metadata cheaply without pulling content. CDN
bundles expose the same file at `<url>/ff-plugin.json`.

## Running the registry

The host always discovers its apps from the registry; what differs is what backs
the registry. Two modes, selected by which config file is loaded (`:5180`):

### Dev mode — backed by the Vite dev servers (no OCI needed)

`registry.config.yaml` (the default) points each plugin at its Vite dev server,
so the dev loop needs no OCI registry:

```bash
npm run dev -w @ff/plugin-registry
```

`npm run dev` at the **repo root** already starts this alongside the host and the
three plugin dev servers — so normally you don't run it by hand.

### OCI ("oras") mode — backed by content-addressed artifacts

`registry.config.oci.yaml` declares `oci` sources. This is the deployed path:
plugins are pulled from an OCI registry and served content-addressed. First
publish the plugins, then run the registry against the OCI config.

**Dependencies:** a local OCI registry (zot — standalone binary, no Docker) and
the `oras` push CLI.

```bash
# 1. Start a local OCI registry (zot). Downloads the binary on first run; :5001.
packages/plugin-registry/scripts/zot.sh

# 2. Install the push tool (once).
brew install oras

# 3. Build + push each plugin as an ORAS-style artifact. Run from the REPO ROOT
#    (the script resolves the plugin dir against the cwd, so don't use `npm -w`).
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-example --tag dev
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-map     --tag dev
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-places  --tag dev
#    package-plugin options: --tag <tag> --registry <host> --repo-prefix <p> --no-build

# 4. Run the registry against the OCI config (the dev:oci script sets FF_REGISTRY_CONFIG).
npm run dev:oci -w @ff/plugin-registry

# 5. Inspect — responses now carry content-addressed /content/<repo>@<digest>/ URLs.
curl localhost:5180/v1/plugins | jq
```

To point the **host** at this, it already targets `:5180`, so just run the host
(`npm run dev:host`) with the registry in OCI mode. Port 5000 is avoided
deliberately — macOS AirPlay Receiver squats on it.

## Config

`registry.config.yaml`: a `plugins` map keyed by opaque handles. Each value has a
`source` (`oci` ref by tag or `@sha256` digest, an `http` url, or `external`) and
optional `metadata` overrides shallow-merged over the manifest reported by the
source.

An optional `cache` block tunes content-cache eviction:

```yaml
cache:
  maxMB: 512        # LRU size cap for evictable bundles (default 512)
  ttlMinutes: 60    # evict an evictable bundle this long after its last use (default 60)
  sweepSeconds: 60  # eviction sweep interval (default 60)
```

## Content cache + eviction

Extracted bundles live in `$FF_CONTENT_CACHE` (default `<os tmpdir>/ff-plugin-content`),
one directory per manifest digest. Because the key is a digest, content is
immutable and reused as long as it's present (and across restarts — the cache
re-registers existing bundles on startup).

Eviction keeps it bounded: the digests of **currently-configured plugins are
pinned and never evicted** (refreshed from the resolver, so they track moving
tags). Everything else — old versions of a configured plugin, or plugins removed
from config — is evicted either `ttlMinutes` after its last use, or, when the
cache exceeds `maxMB`, least-recently-used first.

## Layout

```
src/
  types.ts       PluginManifest, sources, config, ResolvedPlugin
  config.ts      load + validate YAML
  oci/client.ts  pull-only OCI distribution client (manifests + blobs)
  resolver.ts    sources -> digests/manifests; repo -> registry allowlist; TTL cache
  cache.ts       content-addressed on-disk cache of unpacked bundles + eviction
  content.ts     GET /content/<repo>@<digest>/<path>
  discovery.ts   GET /v1/plugins
  server.ts      wiring (Hono + @hono/node-server)
scripts/
  zot.sh             download + run standalone zot
  package-plugin.ts  build -> tar -> `oras push`
```
