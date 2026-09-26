import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';

export interface RoleConfig {
  label: string;
  canEdit?: boolean;
}

export interface UserConfig {
  name: string;
  role: string;
}

export interface AuthConfig {
  /** `dev`: tokens are issued by /v1/auth/dev-login (no password). */
  mode: 'dev';
  secret: string;
  tokenTtlHours: number;
  defaultUser: string;
  users: Record<string, UserConfig>;
}

export interface ServiceConfig {
  auth: AuthConfig;
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
  const auth = raw.auth;
  if (!auth?.users || Object.keys(auth.users).length === 0) throw new Error(`${path}: no auth.users`);
  for (const [id, user] of Object.entries(auth.users)) {
    if (!raw.roles[user.role]) throw new Error(`${path}: user “${id}” has unknown role “${user.role}”`);
  }
  const defaultUser = auth.defaultUser ?? Object.keys(auth.users)[0];
  if (!auth.users[defaultUser]) throw new Error(`${path}: auth.defaultUser isn’t a user`);
  return {
    auth: {
      mode: 'dev',
      secret: process.env.FF_LAYOUT_JWT_SECRET ?? auth.secret ?? 'dev-only-insecure-secret',
      tokenTtlHours: auth.tokenTtlHours ?? 12,
      defaultUser,
      users: auth.users,
    },
    registry: process.env.FF_PLUGIN_REGISTRY_URL ?? raw.registry ?? 'http://localhost:5180',
    dataDir: raw.dataDir ?? '.data',
    defaultRole,
    roles: raw.roles,
    seedViewRoles: raw.seedViewRoles ?? {},
  };
}
