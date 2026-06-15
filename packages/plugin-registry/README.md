# @ff/plugin-registry — plugin distribution + discovery (prototype)

Distributes federated-frontend plugins as **ORAS-style OCI artifacts** and serves
them to host applications. One process, two responsibilities behind a shared
source resolver:

- **Content (dumb, content-addressed):** `GET /content/<digest>/<path>` serves a
  file from the unpacked bundle identified by an OCI manifest `<digest>`. It knows
  only digests — never tags — so responses are immutable (`Cache-Control:
  immutable`).
- **Discovery:** `GET /v1/plugins?<filters>` returns each configured plugin's
  manifest plus an **immutable** content URL. For OCI-by-tag sources the tag is
  resolved to a digest at query time and a `/content/<digest>/` URL is minted, so
  the moving tag never reaches the host. For CDN sources the configured immutable
  URL is returned unchanged.

Combining them is deliberate: both halves need the same thing — the source list
and the tag→digest resolver. The resolver records a `digest → repo` index so the
content endpoint can pull a bare digest (and rejects digests that aren't from a
configured source — that's also the safety allowlist).

## What a plugin is on the wire

A plugin = its unpacked static bundle (`dist/`) + a **manifest** authored as
`ff-plugin.json` at the plugin root (the single source of truth). The packaging
step copies it into the bundle and also lifts it into the artifact's **config
blob**, so discovery can read metadata cheaply without pulling content. CDN
bundles expose the same file at `<url>/ff-plugin.json`.

## Run it

```bash
# 1. A local OCI registry (zot, standalone binary — no Docker). Listens on :5001.
packages/plugin-registry/scripts/zot.sh

# 2. Install the push tool (once).
brew install oras

# 3. Build + push the plugins as artifacts. Run from the repo root (the script
#    resolves the plugin dir against the cwd, so don't use `npm -w`).
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-example --tag dev
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-map     --tag dev
npx tsx packages/plugin-registry/scripts/package-plugin.ts packages/plugin-places  --tag dev

# 4a. Dev: registry backed by the Vite dev servers (default config). :5180
npm run dev -w @ff/plugin-registry

# 4b. Deployed: registry backed by the OCI artifacts you just pushed.
FF_REGISTRY_CONFIG=packages/plugin-registry/registry.config.oci.yaml npm run dev -w @ff/plugin-registry

# 5. Inspect — OCI-backed responses carry content-addressed /content/<digest>/ URLs.
curl localhost:5180/v1/plugins | jq
```

Port 5000 is avoided deliberately — macOS AirPlay Receiver squats on it.

## Config

`registry.config.yaml`: a `plugins` map keyed by opaque handles. Each value has a
`source` (`oci` ref by tag or `@sha256` digest, or a `cdn` url) and optional
`metadata` overrides shallow-merged over the manifest reported by the source.

## Layout

```
src/
  types.ts       PluginManifest, sources, config, ResolvedPlugin
  config.ts      load + validate YAML
  oci/client.ts  pull-only OCI distribution client (manifests + blobs)
  resolver.ts    sources -> digests/manifests; digest -> repo index; TTL cache
  cache.ts       content-addressed on-disk cache of unpacked bundles
  content.ts     GET /content/<digest>/<path>
  discovery.ts   GET /v1/plugins
  server.ts      wiring (Hono + @hono/node-server)
scripts/
  zot.sh             download + run standalone zot
  package-plugin.ts  build -> tar -> `oras push`
```
