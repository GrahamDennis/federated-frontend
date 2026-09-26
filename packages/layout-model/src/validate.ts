import {checkExpr, toIdentifier} from './expressions';
import {MAX_GRID, blockFor, blockName, inBounds, rectsOverlap, type BlockRegistry, type LayoutView} from './layout';
import {knownBlocks, scopeFor, type AppPorts} from './scope';

export interface ValidationError {
  /** Where, e.g. `slots.s2` or `bindings.places.place`. */
  path: string;
  message: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Check a view (and the block registry it's saved with) against the apps that
 * exist: grid geometry, block references, block names, and every binding —
 * direct wires must connect type-compatible ports, and CEL expressions must
 * parse and type-check to the input's type. The layout service runs this on
 * every save; the editor shows the same checks live.
 */
export function validateLayout(
  view: LayoutView,
  blocks: BlockRegistry,
  apps: AppPorts[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({path, message});
  const appIds = apps.map((a) => a.id);
  const appOf = (blockId: string) => {
    const block = blockFor(blocks, blockId, appIds);
    return block ? apps.find((a) => a.id === block.appId) : undefined;
  };

  // View shape and grid.
  if (!ID.test(view.id ?? '')) err('id', 'View id must be 1–64 letters, digits, "-" or "_"');
  if (!view.name?.trim()) err('name', 'View needs a name');
  for (const [key, n] of [['cols', view.cols], ['rows', view.rows]] as const) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_GRID) err(key, `${key} must be 1–${MAX_GRID}`);
  }

  // Slots: unique, inside the grid, not overlapping, showing real blocks.
  const seen = new Set<string>();
  view.slots.forEach((slot, i) => {
    const path = `slots.${slot.id}`;
    if (seen.has(slot.id)) err(path, 'Duplicate slot id');
    seen.add(slot.id);
    if (!inBounds(view, slot)) err(path, 'Slot is outside the grid');
    for (const other of view.slots.slice(i + 1)) {
      if (rectsOverlap(slot, other)) err(path, `Overlaps slot ${other.id}`);
    }
    if (slot.blockId && !appOf(slot.blockId)) err(path, `Unknown block “${slot.blockId}”`);
  });

  // Block registry: real apps, valid and unique expression names.
  const names = new Map<string, string>();
  for (const {block} of knownBlocks(blocks, apps)) {
    const name = blockName(block);
    if (toIdentifier(name) !== name) err(`blocks.${block.id}`, `“${name}” isn’t a valid expression name`);
    const clash = names.get(name);
    if (clash) err(`blocks.${block.id}`, `Expression name “${name}” is also used by ${clash}`);
    names.set(name, block.id);
  }
  for (const block of Object.values(blocks)) {
    if (!appIds.includes(block.appId)) err(`blocks.${block.id}`, `Unknown app “${block.appId}”`);
  }

  // Bindings: a real input, and a type-compatible source.
  const scope = scopeFor(blocks, apps);
  for (const b of view.bindings ?? []) {
    const path = `bindings.${b.blockId}.${b.input}`;
    const input = appOf(b.blockId)?.inputs?.[b.input];
    if (!input) {
      err(path, `“${b.blockId}” has no input “${b.input}”`);
      continue;
    }
    if (b.from) {
      const output = appOf(b.from.blockId)?.outputs?.[b.from.output];
      if (!output) err(path, `“${b.from.blockId}” has no output “${b.from.output}”`);
      else if (![input.type, 'any'].includes(output.type) && input.type !== 'any') {
        err(path, `Output type ${output.type} doesn’t match input type ${input.type}`);
      }
    } else if (b.expr !== undefined) {
      if (b.lang && b.lang !== 'cel') err(path, `Unsupported expression language “${b.lang}”`);
      else if (b.expr.trim()) {
        const check = checkExpr(b.expr, scope, input.type);
        if (!check.ok) err(path, check.message);
      }
    } else {
      err(path, 'Binding has neither a source nor an expression');
    }
  }
  return errors;
}
