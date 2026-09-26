import {Environment, type ASTNode, type ParseResult} from '@marcbachmann/cel-js';
import type {BBox, NumberRange, PortType, PortValue, SelectedPlace} from '@ff/protocol';

/**
 * Derived expressions, in CEL (the Common Expression Language — cel.dev), via
 * `@marcbachmann/cel-js`. CEL is non-Turing-complete, side-effect free and
 * statically typed, and has implementations in Go/Java/C++ as well as JS, so a
 * server could validate or evaluate the same bindings later.
 *
 * Each block in scope is a CEL variable, named by the block's short name, whose
 * fields are its declared outputs, typed from the port types:
 *
 *   bboxAround(histogram.selection, 1500)
 *   nearby.?selection.orValue(histogram.selection)
 *   has(overview.selection) ? overview.selection : detail.selection
 *
 * Outputs that haven't been published yet are *absent* (not null) — use CEL's
 * `has(x.out)` or optional chaining `x.?out.orValue(…)` to handle them. Any
 * evaluation error (e.g. reading an absent output) makes the input null, which
 * gives the "not available yet" behaviour without special cases.
 */

// ---- Types: port types ⇄ CEL types ----

class Place {
  constructor(value: SelectedPlace) {
    Object.assign(this, value);
  }
}
class BBoxValue {
  constructor(value: BBox) {
    Object.assign(this, value);
  }
}
class RangeValue {
  constructor(value: NumberRange) {
    Object.assign(this, value);
  }
}

const CEL_TYPES: Record<string, string> = {
  place: 'Place',
  bbox: 'BBox',
  range: 'Range',
  number: 'double',
  string: 'string',
  boolean: 'bool',
};

/** The CEL type used for a port type (`dyn` when there's no mapping). */
export function celTypeOf(portType: PortType): string {
  return CEL_TYPES[portType] ?? 'dyn';
}

// ---- Functions ----

const KM_PER_DEG = 111.32;
type P = SelectedPlace;

function bboxAround(p: P, km: number): BBoxValue {
  const dLat = km / KM_PER_DEG;
  const dLon = km / (KM_PER_DEG * Math.max(0.01, Math.cos((p.latitude * Math.PI) / 180)));
  return new BBoxValue({
    west: p.longitude - dLon,
    east: p.longitude + dLon,
    south: Math.max(-90, p.latitude - dLat),
    north: Math.min(90, p.latitude + dLat),
  });
}

function distanceKm(a: P, b: P): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Custom functions, with docs for the editor. `int` overloads accept `1500` as well as `1500.0`. */
export const FUNCTIONS: {signature: string; doc: string; handler: (...args: any[]) => unknown}[] = [
  {signature: 'bboxAround(Place, double): BBox', doc: 'Box extending km around a place', handler: bboxAround},
  {signature: 'bboxAround(Place, int): BBox', doc: '', handler: (p, km: bigint) => bboxAround(p, Number(km))},
  {signature: 'distanceKm(Place, Place): double', doc: 'Great-circle distance', handler: distanceKm},
  {
    signature: 'intersect(BBox, BBox): BBox',
    doc: 'Overlap of two boxes (no value if they don’t overlap)',
    handler: (a: BBox, b: BBox) => {
      const box = {
        west: Math.max(a.west, b.west),
        east: Math.min(a.east, b.east),
        south: Math.max(a.south, b.south),
        north: Math.min(a.north, b.north),
      };
      if (box.west > box.east || box.south > box.north) throw new Error('boxes do not overlap');
      return new BBoxValue(box);
    },
  },
  {
    signature: 'union(BBox, BBox): BBox',
    doc: 'Box covering both',
    handler: (a: BBox, b: BBox) =>
      new BBoxValue({
        west: Math.min(a.west, b.west),
        east: Math.max(a.east, b.east),
        south: Math.min(a.south, b.south),
        north: Math.max(a.north, b.north),
      }),
  },
  {
    signature: 'center(BBox): Place',
    doc: 'Centre of a box, as a place',
    handler: (b: BBox) =>
      new Place({
        id: 'center',
        name: 'Center',
        latitude: (b.south + b.north) / 2,
        longitude: (b.west + b.east) / 2,
      }),
  },
  {
    signature: 'place(string, double, double): Place',
    doc: 'place(name, latitude, longitude)',
    handler: (name: string, latitude: number, longitude: number) =>
      new Place({id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, latitude, longitude}),
  },
  {
    signature: 'bbox(double, double, double, double): BBox',
    doc: 'bbox(west, south, east, north)',
    handler: (west, south, east, north) => new BBoxValue({west, south, east, north}),
  },
  {
    signature: 'range(double, double): Range',
    doc: 'range(min, max)',
    handler: (a: number, b: number) => new RangeValue({min: Math.min(a, b), max: Math.max(a, b)}),
  },
  {
    signature: 'inRange(double, Range): bool',
    doc: 'min ≤ x < max',
    handler: (x: number, r: NumberRange) => x >= r.min && x < r.max,
  },
];

/** CEL built-ins worth surfacing in the editor's help. */
export const IDIOMS: {example: string; doc: string}[] = [
  {example: 'has(a.selection)', doc: 'Whether an output has been published'},
  {example: 'a.?selection.orValue(b.selection)', doc: 'First available of two outputs'},
  {example: 'cond ? x : y', doc: 'Conditional'},
  {example: 'a.selection.latitude > 30.0', doc: 'Fields & comparisons (doubles need a .0)'},
];

function baseEnvironment(): Environment {
  const env = new Environment({enableOptionalTypes: true})
    .registerType('Place', {
      ctor: Place,
      fields: {id: 'string', name: 'string', latitude: 'double', longitude: 'double'},
      convert: (v: SelectedPlace) => (v instanceof Place ? v : new Place(v)),
    })
    .registerType('BBox', {
      ctor: BBoxValue,
      fields: {west: 'double', south: 'double', east: 'double', north: 'double'},
      convert: (v: BBox) => (v instanceof BBoxValue ? v : new BBoxValue(v)),
    })
    .registerType('Range', {
      ctor: RangeValue,
      fields: {min: 'double', max: 'double'},
      convert: (v: NumberRange) => (v instanceof RangeValue ? v : new RangeValue(v)),
    });
  for (const fn of FUNCTIONS) env.registerFunction(fn.signature, fn.handler);
  return env;
}

// ---- Scope: which blocks an expression can see ----

/** A block visible to expressions: its CEL name and its typed outputs. */
export interface ScopeBlock {
  name: string;
  blockId: string;
  outputs: Record<string, PortType>;
}
export type ExprScope = ScopeBlock[];

const RESERVED = new Set(
  'in as break const continue else for function if import let loop package namespace return var void while true false null has dyn'.split(
    ' ',
  ),
);

/** Turn an arbitrary id into a valid CEL identifier (`world-map~2` → `world_map_2`). */
export function toIdentifier(text: string): string {
  let id = text.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return RESERVED.has(id) ? `${id}_` : id;
}

let base: Environment | null = null;
const environments = new Map<string, Environment>();
const compiled = new Map<string, ParseResult | Error>();

function environmentFor(scope: ExprScope): {env: Environment; key: string} {
  const key = JSON.stringify(scope.map((b) => [b.name, b.outputs]));
  let env = environments.get(key);
  if (!env) {
    base ??= baseEnvironment();
    env = base.clone();
    const seen = new Set<string>();
    for (const block of scope) {
      if (seen.has(block.name) || Object.keys(block.outputs).length === 0) continue;
      seen.add(block.name);
      const schema = Object.fromEntries(
        Object.entries(block.outputs).map(([output, type]) => [output, celTypeOf(type)]),
      );
      env.registerVariable({name: block.name, schema});
    }
    if (environments.size > 20) environments.clear();
    environments.set(key, env);
  }
  return {env, key};
}

function compile(src: string, scope: ExprScope): ParseResult | Error {
  const {env, key} = environmentFor(scope);
  const cacheKey = `${key}\u0000${src}`;
  let hit = compiled.get(cacheKey);
  if (!hit) {
    try {
      hit = env.parse(src);
    } catch (error) {
      hit = error instanceof Error ? error : new Error(String(error));
    }
    if (compiled.size > 500) compiled.clear();
    compiled.set(cacheKey, hit);
  }
  return hit;
}

// ---- Checking (for the editor) ----

export type CheckResult =
  | {ok: true; type: string}
  | {ok: false; message: string; start?: number; end?: number};

/** Parse + type-check `src`, optionally against the input's expected port type. */
export function checkExpr(src: string, scope: ExprScope, expected?: PortType): CheckResult {
  const parsed = compile(src, scope);
  const result: {valid: boolean; type?: unknown; error?: unknown} =
    parsed instanceof Error ? {valid: false, error: parsed} : parsed.check();
  if (!result.valid) {
    const error = result.error as Error & {summary?: string; range?: {start: number; end: number}};
    return {
      ok: false,
      message: error?.summary ?? error?.message.split('\n')[0] ?? 'Invalid expression',
      start: error?.range?.start,
      end: error?.range?.end,
    };
  }
  const type = String(result.type);
  if (expected) {
    const want = celTypeOf(expected);
    if (want !== 'dyn' && type !== 'dyn' && type !== want) {
      return {ok: false, message: `Returns ${type}, but this input expects ${want}`};
    }
  }
  return {ok: true, type};
}

// ---- Evaluation ----

export type OutputLookup = (blockId: string, output: string) => PortValue | null | undefined;

/** Evaluate `src`; any parse, type or evaluation error yields null. */
export function evaluateExpr(src: string, scope: ExprScope, outputOf: OutputLookup): PortValue | null {
  const parsed = compile(src, scope);
  if (parsed instanceof Error) return null;
  // Only published outputs are present, so `has()` / `.?` see the difference.
  const context: Record<string, Record<string, unknown>> = {};
  for (const block of scope) {
    const values: Record<string, unknown> = {};
    for (const output of Object.keys(block.outputs)) {
      const value = outputOf(block.blockId, output);
      if (value != null) values[output] = value;
    }
    context[block.name] ??= values;
  }
  try {
    return toPlain(parsed(context));
  } catch {
    return null;
  }
}

/** CEL values → plain JSON (bigint → number, Map/class instances → objects, optional → value). */
function toPlain(value: unknown): PortValue | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value as PortValue;
  const maybeOptional = value as {hasValue?: () => boolean; value?: () => unknown};
  if (typeof maybeOptional.hasValue === 'function') {
    return maybeOptional.hasValue() ? toPlain(maybeOptional.value!()) : null;
  }
  if (Array.isArray(value)) return value.map(toPlain) as PortValue;
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Object.fromEntries(entries.map(([k, v]) => [String(k), toPlain(v)])) as PortValue;
}

// ---- References ----

/** The `block.output` pairs an expression reads (by CEL name), from its AST. */
export function referencedOutputs(src: string): {name: string; output: string}[] {
  let ast: ASTNode;
  try {
    // Our environment's parser (the package-level one lacks optional chaining).
    ast = (base ??= baseEnvironment()).parse(src).ast;
  } catch {
    return [];
  }
  const refs: {name: string; output: string}[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !('op' in node)) return;
    const {op, args} = node as {op: string; args: unknown};
    if ((op === '.' || op === '.?') && Array.isArray(args)) {
      const [target, field] = args as [{op?: string; args?: unknown}, unknown];
      if (target?.op === 'id' && typeof field === 'string') {
        refs.push({name: String(target.args), output: field});
        return;
      }
    }
    walk(args);
  };
  walk(ast);
  return refs;
}
