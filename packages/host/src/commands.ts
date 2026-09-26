import type {BlockInputs, CommandRef} from '@ff/protocol';

/**
 * Whether a plugin instance may run `ref`: only if that exact command reference
 * appears somewhere in its current (author-wired) inputs. A plugin can't mint
 * authority by itself — it can only use what the layout author handed it, e.g.
 * a button list built with CEL's `command("detail", "map.fly.sydney")`.
 */
export function inputsAuthorize(inputs: BlockInputs, ref: CommandRef): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const candidate = value as Partial<CommandRef>;
    if (candidate.block === ref.block && candidate.command === ref.command) return true;
    return Object.values(value).some(visit);
  };
  return Object.values(inputs).some(visit);
}
