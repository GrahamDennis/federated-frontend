import type {PortType} from '@ff/protocol';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkCommand(v: unknown): string | null {
  if (!isObject(v) || typeof v.block !== 'string' || typeof v.command !== 'string') {
    return 'expected {block, command} strings';
  }
  return null;
}

/**
 * Check a value a plugin publishes against its declared port type. Returns a
 * reason if it doesn't fit, else null. `null` always fits (it clears the
 * output); `any` and unknown types accept any JSON value. Plugins are
 * untrusted, so the host checks before routing a value to other blocks.
 */
export function validatePortValue(type: PortType, value: unknown): string | null {
  if (value === null) return null;
  switch (type) {
    case 'place':
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
        return 'expected a place with string id and name';
      }
      if (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90) {
        return 'expected latitude between -90 and 90';
      }
      if (!isFiniteNumber(value.longitude)) return 'expected a numeric longitude';
      return null;
    case 'bbox':
      if (!isObject(value) || !['west', 'south', 'east', 'north'].every((k) => isFiniteNumber(value[k]))) {
        return 'expected a bbox with numeric west, south, east and north';
      }
      return (value.south as number) <= (value.north as number) ? null : 'expected south ≤ north';
    case 'range':
      if (!isObject(value) || !isFiniteNumber(value.min) || !isFiniteNumber(value.max)) {
        return 'expected a range with numeric min and max';
      }
      return value.min <= value.max ? null : 'expected min ≤ max';
    case 'command':
      return checkCommand(value);
    case 'buttons': {
      if (!Array.isArray(value)) return 'expected a list of buttons';
      for (const [i, b] of value.entries()) {
        if (!isObject(b) || typeof b.label !== 'string') return `button ${i}: expected a string label`;
        if (b.command !== undefined && checkCommand(b.command)) return `button ${i}: ${checkCommand(b.command)}`;
      }
      return null;
    }
    case 'number':
      return isFiniteNumber(value) ? null : 'expected a finite number';
    case 'string':
      return typeof value === 'string' ? null : 'expected a string';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected true or false';
    default:
      return null;
  }
}
