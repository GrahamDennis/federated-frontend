import type {PortDescriptor} from '@ff/protocol';
import type {ExprScope} from './expressions';
import {blockFor, blockName, type Block, type BlockRegistry} from './layout';

/** What the model needs to know about an app: its id and its typed ports. */
export interface AppPorts {
  id: string;
  inputs?: Record<string, PortDescriptor>;
  outputs?: Record<string, PortDescriptor>;
}

/** Every block that exists: each app's implicit default, plus registry entries. */
export function knownBlocks(blocks: BlockRegistry, apps: AppPorts[]): {block: Block; app: AppPorts}[] {
  const appIds = apps.map((app) => app.id);
  return [...new Set([...appIds, ...Object.keys(blocks)])].flatMap((id) => {
    const block = blockFor(blocks, id, appIds);
    const app = block && apps.find((a) => a.id === block.appId);
    return block && app ? [{block, app}] : [];
  });
}

/** Every known block with outputs, as the scope CEL expressions can read. */
export function scopeFor(blocks: BlockRegistry, apps: AppPorts[]): ExprScope {
  return knownBlocks(blocks, apps)
    .filter(({app}) => app.outputs)
    .map(({block, app}) => ({
      name: blockName(block),
      blockId: block.id,
      outputs: Object.fromEntries(
        Object.entries(app.outputs!).map(([output, port]) => [output, port.type]),
      ),
    }));
}
