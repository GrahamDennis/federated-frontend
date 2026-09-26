import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_BLOCKS, DEFAULT_VIEWS, type BlockRegistry, type LayoutView} from '@ff/layout-model';

/** Everything saved for one workspace. */
export interface Workspace {
  views: LayoutView[];
  blocks: BlockRegistry;
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isWorkspaceId(id: string): boolean {
  return WORKSPACE_ID.test(id);
}

/**
 * Layouts per workspace (tenant). New workspaces are seeded from the shared
 * model's default views and blocks, with each default view's `roles` taken from
 * config. Persisted as one JSON file per workspace, or kept in memory only
 * (`ephemeral`, used by the e2e tests so parallel runs stay isolated).
 */
export class WorkspaceStore {
  private readonly cache = new Map<string, Workspace>();

  constructor(
    private readonly dir: string | null,
    private readonly seedViewRoles: Record<string, string[]>,
  ) {}

  seed(): Workspace {
    return structuredClone({
      views: DEFAULT_VIEWS.map((view) => ({...view, roles: this.seedViewRoles[view.id] ?? []})),
      blocks: DEFAULT_BLOCKS,
    });
  }

  async get(id: string): Promise<Workspace> {
    let workspace = this.cache.get(id);
    if (!workspace) {
      workspace = (await this.read(id)) ?? this.seed();
      this.cache.set(id, workspace);
    }
    return workspace;
  }

  async put(id: string, workspace: Workspace): Promise<void> {
    this.cache.set(id, workspace);
    if (!this.dir) return;
    await mkdir(this.dir, {recursive: true});
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(workspace, null, 2));
  }

  private async read(id: string): Promise<Workspace | null> {
    if (!this.dir) return null;
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as Workspace;
    } catch {
      return null;
    }
  }
}
