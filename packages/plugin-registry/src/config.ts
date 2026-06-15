import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import type {RegistryConfig} from './types.ts';

const DEFAULT_INSECURE = ['localhost:5001', '127.0.0.1:5001'];

/** Load and lightly validate the YAML config. */
export async function loadConfig(path: string): Promise<RegistryConfig> {
  const raw = parse(await readFile(path, 'utf8')) as Partial<RegistryConfig> | null;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config ${path}: expected a YAML object`);
  }
  if (!raw.plugins || typeof raw.plugins !== 'object') {
    throw new Error(`config ${path}: missing \`plugins\` map`);
  }

  for (const [key, entry] of Object.entries(raw.plugins)) {
    const src = entry?.source;
    if (!src || !['oci', 'http', 'external'].includes(src.type)) {
      throw new Error(`config ${path}: plugin \`${key}\` needs source.type 'oci' | 'http' | 'external'`);
    }
    if (src.type === 'oci' && !src.ref) {
      throw new Error(`config ${path}: plugin \`${key}\` (oci) needs source.ref`);
    }
    if ((src.type === 'http' || src.type === 'external') && !src.url) {
      throw new Error(`config ${path}: plugin \`${key}\` (${src.type}) needs source.url`);
    }
    if (src.type === 'external' && !entry.metadata?.id) {
      throw new Error(`config ${path}: plugin \`${key}\` (external) needs metadata.id (no ff-plugin.json to read)`);
    }
  }

  return {
    contentBaseUrl: raw.contentBaseUrl,
    insecureRegistries: [...DEFAULT_INSECURE, ...(raw.insecureRegistries ?? [])],
    plugins: raw.plugins,
  };
}
