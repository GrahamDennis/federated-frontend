import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';

export interface RoleConfig {
  label: string;
  canEdit?: boolean;
}

export interface ServiceConfig {
  registry: string;
  dataDir: string;
  defaultRole: string;
  roles: Record<string, RoleConfig>;
  seedViewRoles?: Record<string, string[]>;
}

export async function loadConfig(path: string): Promise<ServiceConfig> {
  const raw = parse(await readFile(path, 'utf8')) as Partial<ServiceConfig>;
  if (!raw.roles || Object.keys(raw.roles).length === 0) throw new Error(`${path}: no roles`);
  const defaultRole = raw.defaultRole ?? Object.keys(raw.roles)[0];
  if (!raw.roles[defaultRole]) throw new Error(`${path}: defaultRole “${defaultRole}” isn’t a role`);
  return {
    registry: process.env.FF_PLUGIN_REGISTRY_URL ?? raw.registry ?? 'http://localhost:5180',
    dataDir: raw.dataDir ?? '.data',
    defaultRole,
    roles: raw.roles,
    seedViewRoles: raw.seedViewRoles ?? {},
  };
}
