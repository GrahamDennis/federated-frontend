import {Hono} from 'hono';
import type {Resolver, ResolvedSource} from './resolver.ts';
import type {RegistryConfig, ResolvedPlugin} from './types.ts';

/**
 * The discovery half. `GET /v1/plugins?<filters>` returns each configured
 * plugin's manifest plus an IMMUTABLE content URL: for OCI sources the tag is
 * resolved to a digest and a `/content/<digest>/` URL is minted (the moving tag
 * never reaches the host); for CDN sources the configured immutable URL is
 * returned unchanged.
 */
export function discoveryRouter(resolver: Resolver, config: RegistryConfig): Hono {
  const app = new Hono();

  app.get('/v1/plugins', async (c) => {
    const base = (config.contentBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '');
    const sources = await resolver.resolveAll();
    let plugins = sources.map((s) => toResolvedPlugin(s, base));

    // Filters: `q` is a substring match over id/name/description; any other
    // query param is an equality match against the same-named manifest field.
    const q = c.req.query('q')?.toLowerCase();
    if (q) {
      plugins = plugins.filter((p) =>
        [p.id, p.name, p.description].some((v) => v?.toLowerCase().includes(q)),
      );
    }
    for (const [field, value] of Object.entries(c.req.queries())) {
      if (field === 'q') continue;
      plugins = plugins.filter((p) =>
        value.includes(String((p as unknown as Record<string, unknown>)[field])),
      );
    }

    return c.json({plugins}, 200, {'Access-Control-Allow-Origin': '*'});
  });

  return app;
}

function toResolvedPlugin(s: ResolvedSource, contentBase: string): ResolvedPlugin {
  // `entry` is folded into `entryUrl`; it isn't part of the resolved view.
  const {entry = 'index.html', ...manifest} = s.manifest;

  // `external` URLs are used verbatim (no bundle, no entry document); `oci` and
  // `http` expose a bundle whose entry document is appended.
  if (s.kind === 'external') {
    return {...manifest, key: s.key, url: s.url, entryUrl: s.url};
  }
  // OCI content URL = the artifact's own coordinate: /content/<repo>@<digest>/.
  // The repo makes it self-documenting; `@` and `:` are path-safe, so neither is
  // percent-encoded (reads as `…/content/ff-plugins/world-map@sha256:0636…/`).
  const url =
    s.kind === 'oci' ? `${contentBase}/content/${s.repository}@${s.digest}/` : s.url;
  return {
    ...manifest,
    key: s.key,
    digest: s.kind === 'oci' ? s.digest : undefined,
    url,
    entryUrl: url + entry,
  };
}
