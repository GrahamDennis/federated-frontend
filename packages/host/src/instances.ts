import {resolveSettings, type BlockSettings} from '@ff/protocol';
import type {AppDescriptor} from './apps';
import {blockFor, blockName, type Block, type BlockRegistry} from './layout';
import type {ExprScope} from './expressions';

/**
 * A runnable instance of an app: what the chrome actually mounts (one iframe +
 * thread each). Apps mode shows each app's default instance (id = app id);
 * layout slots can show any block, including extra instances of the same app.
 */
export interface Instance {
  id: string;
  app: AppDescriptor;
  label: string;
  /** Identifier expressions use to refer to this block's outputs. */
  name: string;
  /** Resolved settings: the block's values over the app's declared defaults. */
  settings: BlockSettings;
  block: Block;
}

export function instanceFor(
  blocks: BlockRegistry,
  id: string,
  apps: AppDescriptor[],
): Instance | null {
  const block = blockFor(blocks, id, apps.map((app) => app.id));
  const app = block && apps.find((a) => a.id === block.appId);
  if (!block || !app) return null;
  return {
    id,
    app,
    label: block.label || app.name,
    name: blockName(block),
    settings: resolveSettings(app.settings, block.settings),
    block,
  };
}

/** Every block that can be picked: each app's default, plus explicit instances. */
export function knownInstances(blocks: BlockRegistry, apps: AppDescriptor[]): Instance[] {
  const ids = [...apps.map((app) => app.id), ...Object.keys(blocks)];
  return [...new Set(ids)]
    .map((id) => instanceFor(blocks, id, apps))
    .filter((i): i is Instance => i !== null);
}

/** Every known block with outputs, as the scope derived expressions can read. */
export function exprScope(blocks: BlockRegistry, apps: AppDescriptor[]): ExprScope {
  return knownInstances(blocks, apps)
    .filter((i) => i.app.outputs)
    .map((i) => ({
      name: i.name,
      blockId: i.id,
      outputs: Object.fromEntries(
        Object.entries(i.app.outputs!).map(([output, port]) => [output, port.type]),
      ),
    }));
}
