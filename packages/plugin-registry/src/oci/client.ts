import {createHash} from 'node:crypto';

/** Media types for the plugin artifact (ORAS-style OCI artifact). */
export const PLUGIN_ARTIFACT_TYPE = 'application/vnd.ff.plugin.manifest.v1+json';
export const PLUGIN_CONFIG_MEDIA_TYPE = 'application/vnd.ff.plugin.config.v1+json';
export const PLUGIN_CONTENT_MEDIA_TYPE = 'application/vnd.ff.plugin.content.v1.tar+gzip';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface ParsedRef {
  registry: string;
  repository: string;
  /** A tag, or a `sha256:...` digest when `isDigest`. */
  reference: string;
  isDigest: boolean;
}

/** Parse `registry/repo:tag` or `registry/repo@sha256:...` (registry required). */
export function parseRef(ref: string): ParsedRef {
  let rest = ref;
  let reference = '';
  let isDigest = false;

  const at = rest.indexOf('@');
  if (at !== -1) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
    isDigest = true;
  }

  const slash = rest.indexOf('/');
  if (slash === -1) throw new Error(`ref must include a registry host: ${ref}`);
  const registry = rest.slice(0, slash);
  let repository = rest.slice(slash + 1);

  if (!isDigest) {
    const colon = repository.lastIndexOf(':');
    if (colon !== -1) {
      reference = repository.slice(colon + 1);
      repository = repository.slice(0, colon);
    } else {
      reference = 'latest';
    }
  }
  return {registry, repository, reference, isDigest};
}

/** OCI image manifest shape (only the fields we use). */
export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}
export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
}

export function sha256(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** A read-only client for one registry over the OCI distribution API. */
export class OciClient {
  constructor(private readonly insecureRegistries: string[] = []) {}

  private base(registry: string): string {
    const insecure =
      this.insecureRegistries.includes(registry) ||
      registry.startsWith('localhost') ||
      registry.startsWith('127.0.0.1');
    return `${insecure ? 'http' : 'https'}://${registry}`;
  }

  /** Fetch a manifest by tag or digest. Returns its bytes and resolved digest. */
  async getManifest(
    registry: string,
    repository: string,
    reference: string,
  ): Promise<{digest: string; manifest: OciManifest; raw: Uint8Array}> {
    // Tags and digests are path-safe per the OCI spec; encoding the digest's
    // `:` (→ %3A) would make the registry reject it.
    const url = `${this.base(registry)}/v2/${repository}/manifests/${reference}`;
    const res = await fetch(url, {headers: {Accept: MANIFEST_ACCEPT}});
    if (!res.ok) {
      throw new Error(`OCI getManifest ${registry}/${repository}:${reference} -> ${res.status}`);
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    const digest = res.headers.get('docker-content-digest') ?? sha256(raw);
    const manifest = JSON.parse(new TextDecoder().decode(raw)) as OciManifest;
    return {digest, manifest, raw};
  }

  /** Fetch a blob by digest. */
  async getBlob(registry: string, repository: string, digest: string): Promise<Uint8Array> {
    const url = `${this.base(registry)}/v2/${repository}/blobs/${digest}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OCI getBlob ${registry}/${repository}@${digest} -> ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
