#!/usr/bin/env -S npx tsx
/**
 * Build a plugin and push it to an OCI registry as an ORAS-style artifact.
 *
 *   tsx scripts/package-plugin.ts <plugin-dir> [options]
 *   tsx scripts/package-plugin.ts packages/plugin-map --tag dev
 *
 * Options:
 *   --tag <tag>           image tag (default: dev)
 *   --registry <host>     registry host (default: localhost:5001)
 *   --repo-prefix <p>     repository prefix (default: ff-plugins)
 *   --no-build            skip `npm run build` (use the existing dist/)
 *
 * The artifact = a config blob (the plugin's ff-plugin.json) + one gzipped-tar
 * content layer (the built dist/, with ff-plugin.json copied in). Requires the
 * `oras` CLI (`brew install oras`).
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createTar} from 'nanotar';
import type {PluginManifest} from '../src/types.ts';
import {
  PLUGIN_ARTIFACT_TYPE,
  PLUGIN_CONFIG_MEDIA_TYPE,
  PLUGIN_CONTENT_MEDIA_TYPE,
} from '../src/oci/client.ts';

interface Args {
  pluginDir: string;
  tag: string;
  registry: string;
  repoPrefix: string;
  build: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') build = false;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  if (!positional[0]) {
    console.error('usage: package-plugin.ts <plugin-dir> [--tag dev] [--registry localhost:5001] [--repo-prefix ff-plugins]');
    process.exit(2);
  }
  return {
    pluginDir: resolve(positional[0]),
    tag: opts.tag ?? 'dev',
    registry: opts.registry ?? 'localhost:5001',
    repoPrefix: opts['repo-prefix'] ?? 'ff-plugins',
    build,
  };
}

function ensureOras(): void {
  try {
    execFileSync('oras', ['version'], {stdio: 'ignore'});
  } catch {
    console.error('`oras` CLI not found. Install it: brew install oras');
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));
ensureOras();

// Canonical manifest lives in public/, so Vite serves it in dev AND copies it
// into dist/ on build (the in-bundle `/ff-plugin.json` is therefore automatic).
const manifestPath = join(args.pluginDir, 'public', 'ff-plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
console.log(`Packaging ${manifest.id} (${manifest.name}) from ${args.pluginDir}`);

if (args.build) {
  console.log('Building (npm run build)…');
  execFileSync('npm', ['run', 'build'], {cwd: args.pluginDir, stdio: 'inherit'});
}

const distDir = join(args.pluginDir, 'dist');

// Pack dist/ into a single gzipped tar layer.
const files = readdirSync(distDir, {recursive: true, withFileTypes: true})
  .filter((d) => d.isFile())
  .map((d) => {
    const abs = join(d.parentPath, d.name);
    return {name: relative(distDir, abs), data: readFileSync(abs)};
  });
console.log(`Packing ${files.length} files into content.tar.gz`);
const tarGz = gzipSync(createTar(files));

const work = mkdtempSync(join(tmpdir(), 'ff-package-'));
const tarPath = join(work, 'content.tar.gz');
writeFileSync(tarPath, tarGz);

const ref = `${args.registry}/${args.repoPrefix}/${manifest.id}:${args.tag}`;
const insecure = args.registry.startsWith('localhost') || args.registry.startsWith('127.0.0.1');
const orasArgs = [
  'push',
  ...(insecure ? ['--plain-http'] : []),
  // The tarball lives in a temp dir (absolute path); its filename annotation is
  // irrelevant — the content server extracts the layer by media type and uses
  // the tar entries' own paths.
  '--disable-path-validation',
  '--artifact-type',
  PLUGIN_ARTIFACT_TYPE,
  '--config',
  `${manifestPath}:${PLUGIN_CONFIG_MEDIA_TYPE}`,
  ref,
  `${tarPath}:${PLUGIN_CONTENT_MEDIA_TYPE}`,
];

console.log(`Pushing ${ref}`);
execFileSync('oras', orasArgs, {stdio: 'inherit'});
console.log(`\nDone. Pinned reference:`);
execFileSync('oras', ['resolve', ...(insecure ? ['--plain-http'] : []), ref], {stdio: 'inherit'});
