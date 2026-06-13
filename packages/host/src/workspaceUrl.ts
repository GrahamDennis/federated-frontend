import type {SharedContext} from '@ff/protocol';
import type {AppDescriptor} from './apps';

/**
 * The host owns the top-level URL (plugins are cross-origin iframes and can't
 * touch it), so it serializes the workspace into the URL and restores it on load:
 *
 *   ?app=<primary>&detail=<companion>&ctx=<url-encoded JSON shared context>
 *
 * This makes a composed view shareable / bookmarkable / reloadable — augmenting
 * browser tabs rather than replacing them. The shared context is round-tripped as
 * opaque JSON so the host stays domain-agnostic; the apps interpret it.
 */
export interface WorkspaceState {
  appId: string | undefined;
  detailId: string | null;
  context: SharedContext;
}

export function readWorkspaceFromUrl(apps: AppDescriptor[]): WorkspaceState {
  const params = new URLSearchParams(window.location.search);
  const defaultId = apps.find((app) => !app.detail)?.id;

  let appId = params.get('app') ?? defaultId;
  // Must be a known app that's allowed in the primary position.
  if (!apps.some((app) => app.id === appId && !app.detail)) appId = defaultId;

  let detailId = params.get('detail');
  const active = apps.find((app) => app.id === appId);
  if (!detailId || !active?.detailApps?.includes(detailId)) detailId = null;

  let context: SharedContext = {};
  const raw = params.get('ctx');
  if (raw) {
    try {
      context = JSON.parse(raw) as SharedContext;
    } catch {
      context = {};
    }
  }

  return {appId, detailId, context};
}

export function writeWorkspaceToUrl(
  apps: AppDescriptor[],
  state: WorkspaceState,
): void {
  const params = new URLSearchParams();
  const defaultId = apps.find((app) => !app.detail)?.id;

  if (state.appId && state.appId !== defaultId) params.set('app', state.appId);
  if (state.detailId) params.set('detail', state.detailId);

  const cleaned = cleanContext(state.context);
  if (cleaned) params.set('ctx', JSON.stringify(cleaned));

  const query = params.toString();
  const url = query
    ? `${window.location.pathname}?${query}`
    : window.location.pathname;
  // replaceState: the URL always reflects current state without spamming history.
  window.history.replaceState(null, '', url);
}

/** Drop null/undefined entries; return null if nothing meaningful remains. */
function cleanContext(context: SharedContext): SharedContext | null {
  const entries = Object.entries(context).filter(([, value]) => value != null);
  return entries.length > 0 ? (Object.fromEntries(entries) as SharedContext) : null;
}
