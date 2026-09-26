import {sign, verify} from 'hono/jwt';
import type {AuthConfig} from './config';

/** The claims in a layout-service token. */
export interface Claims {
  /** User id. */
  sub: string;
  name: string;
  role: string;
  /** Workspace (tenant) the session is scoped to. */
  ws: string;
  exp: number;
}

export async function issueToken(
  auth: AuthConfig,
  userId: string,
  workspace: string,
): Promise<string> {
  const user = auth.users[userId];
  const claims: Claims = {
    sub: userId,
    name: user.name,
    role: user.role,
    ws: workspace,
    exp: Math.floor(Date.now() / 1000) + auth.tokenTtlHours * 3600,
  };
  return sign({...claims}, auth.secret, 'HS256');
}

/** Verify a `Bearer` token; null if absent, malformed, badly signed or expired. */
export async function verifyBearer(auth: AuthConfig, header: string | undefined): Promise<Claims | null> {
  const token = header?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    return (await verify(token, auth.secret, 'HS256')) as unknown as Claims;
  } catch {
    return null;
  }
}
