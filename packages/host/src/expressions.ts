import type {BBox, NumberRange, PortValue, SelectedPlace} from '@ff/protocol';

/**
 * Derived expressions: a tiny, pure, host-evaluated language for computing a
 * block input from other blocks' outputs — e.g.
 *
 *   bboxAround(histogram.selection, 1500)
 *   coalesce(histogram~nearby.selection, histogram.selection)
 *   if(gt(distanceKm(a.selection, b.selection), 1000), a.selection, null)
 *
 * Deliberately not JavaScript: there are no operators, variables, loops or
 * access to anything but block outputs and a fixed set of functions, so an
 * expression authored in the editor can't do anything but compute a value. It's
 * call syntax only (`fn(a, b)`), which also lets block ids like
 * `world-map~overview` appear bare in references (`block.output.field…`).
 *
 * Null propagates: most functions return null if any argument is null (a
 * source that hasn't published yet), except the null-aware ones (`coalesce`,
 * `if`, `isNull`, `and`, `or`).
 */

export type Expr =
  | {kind: 'lit'; value: PortValue | null}
  | {kind: 'ref'; blockId: string; output: string; path: string[]}
  | {kind: 'call'; fn: string; args: Expr[]};

/** Value types for inference. Port types are open strings; `any` = unknown. */
export type ValueType = 'number' | 'string' | 'boolean' | 'place' | 'bbox' | 'range' | 'any' | (string & {});

export class ExprError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

// ---- Functions ----

type Value = PortValue | null;

interface FnSpec {
  /** [min, max] argument count (max = Infinity for variadic). */
  arity: [number, number];
  /** Receives nulls as-is instead of short-circuiting to null. */
  nullAware?: boolean;
  /** Result type from argument types. */
  type: (args: ValueType[]) => ValueType;
  call: (...args: any[]) => Value;
  doc: string;
}

const num = (): ValueType => 'number';
const bool = (): ValueType => 'boolean';

const KM_PER_DEG = 111.32;

function bboxAround(place: SelectedPlace, km: number): BBox {
  const dLat = km / KM_PER_DEG;
  const dLon = km / (KM_PER_DEG * Math.max(0.01, Math.cos((place.latitude * Math.PI) / 180)));
  return {
    west: place.longitude - dLon,
    east: place.longitude + dLon,
    south: Math.max(-90, place.latitude - dLat),
    north: Math.min(90, place.latitude + dLat),
  };
}

function distanceKm(a: SelectedPlace, b: SelectedPlace): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const FUNCTIONS: Record<string, FnSpec> = {
  // Null handling / logic
  coalesce: {
    arity: [1, Infinity],
    nullAware: true,
    type: (t) => t.find((x) => x !== 'any') ?? 'any',
    call: (...xs) => xs.find((x) => x != null) ?? null,
    doc: 'First argument that isn’t null',
  },
  if: {
    arity: [3, 3],
    nullAware: true,
    type: (t) => (t[1] !== 'any' ? t[1] : t[2]),
    call: (c, a, b) => (c ? a : b),
    doc: 'if(condition, then, else)',
  },
  isNull: {arity: [1, 1], nullAware: true, type: bool, call: (x) => x == null, doc: 'Whether a value is null'},
  and: {arity: [1, Infinity], nullAware: true, type: bool, call: (...xs) => xs.every(Boolean), doc: 'All truthy'},
  or: {arity: [1, Infinity], nullAware: true, type: bool, call: (...xs) => xs.some(Boolean), doc: 'Any truthy'},
  not: {arity: [1, 1], type: bool, call: (x) => !x, doc: 'Logical not'},
  eq: {arity: [2, 2], type: bool, call: (a, b) => JSON.stringify(a) === JSON.stringify(b), doc: 'Equal'},
  lt: {arity: [2, 2], type: bool, call: (a, b) => a < b, doc: 'a < b'},
  gt: {arity: [2, 2], type: bool, call: (a, b) => a > b, doc: 'a > b'},

  // Arithmetic
  add: {arity: [2, Infinity], type: num, call: (...xs) => xs.reduce((a, b) => a + b), doc: 'Sum'},
  sub: {arity: [2, 2], type: num, call: (a, b) => a - b, doc: 'a − b'},
  mul: {arity: [2, Infinity], type: num, call: (...xs) => xs.reduce((a, b) => a * b), doc: 'Product'},
  div: {arity: [2, 2], type: num, call: (a, b) => (b === 0 ? null : a / b), doc: 'a ÷ b (null if b is 0)'},
  min: {arity: [1, Infinity], type: num, call: (...xs) => Math.min(...xs), doc: 'Smallest'},
  max: {arity: [1, Infinity], type: num, call: (...xs) => Math.max(...xs), doc: 'Largest'},
  round: {
    arity: [1, 2],
    type: num,
    call: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
    doc: 'round(x, digits?)',
  },

  // Ranges
  range: {
    arity: [2, 2],
    type: () => 'range',
    call: (min, max): NumberRange => ({min: Math.min(min, max), max: Math.max(min, max)}),
    doc: 'range(min, max)',
  },
  inRange: {arity: [2, 2], type: bool, call: (x, r: NumberRange) => x >= r.min && x < r.max, doc: 'inRange(x, range)'},

  // Geography
  place: {
    arity: [3, 3],
    type: () => 'place',
    call: (name: string, latitude: number, longitude: number): SelectedPlace => ({
      id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: String(name),
      latitude,
      longitude,
    }),
    doc: 'place(name, lat, lon)',
  },
  bbox: {
    arity: [4, 4],
    type: () => 'bbox',
    call: (west, south, east, north): BBox => ({west, south, east, north}),
    doc: 'bbox(west, south, east, north)',
  },
  bboxAround: {
    arity: [2, 2],
    type: () => 'bbox',
    call: (p: SelectedPlace, km: number) => bboxAround(p, km),
    doc: 'Box extending km around a place',
  },
  intersect: {
    arity: [2, 2],
    type: () => 'bbox',
    call: (a: BBox, b: BBox): BBox | null => {
      const box = {
        west: Math.max(a.west, b.west),
        east: Math.min(a.east, b.east),
        south: Math.max(a.south, b.south),
        north: Math.min(a.north, b.north),
      };
      return box.west <= box.east && box.south <= box.north ? box : null;
    },
    doc: 'Overlap of two boxes (null if none)',
  },
  union: {
    arity: [2, 2],
    type: () => 'bbox',
    call: (a: BBox, b: BBox): BBox => ({
      west: Math.min(a.west, b.west),
      east: Math.max(a.east, b.east),
      south: Math.min(a.south, b.south),
      north: Math.max(a.north, b.north),
    }),
    doc: 'Box covering both',
  },
  center: {
    arity: [1, 1],
    type: () => 'place',
    call: (b: BBox): SelectedPlace => ({
      id: 'center',
      name: 'Center',
      latitude: (b.south + b.north) / 2,
      longitude: (b.west + b.east) / 2,
    }),
    doc: 'Centre of a box, as a place',
  },
  distanceKm: {
    arity: [2, 2],
    type: num,
    call: (a: SelectedPlace, b: SelectedPlace) => distanceKm(a, b),
    doc: 'Great-circle distance between places',
  },
};

// ---- Parsing ----

type Token =
  | {t: 'num'; v: number; pos: number}
  | {t: 'str'; v: string; pos: number}
  | {t: 'id'; v: string; pos: number}
  | {t: 'punct'; v: '(' | ')' | ',' | '.'; pos: number}
  | {t: 'end'; pos: number};

const ID_START = /[A-Za-z_]/;
const ID_CHAR = /[A-Za-z0-9_~-]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if ('(),.'.includes(c)) {
      tokens.push({t: 'punct', v: c as '(' | ')' | ',' | '.', pos: i++});
    } else if (/[0-9]/.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      const m = /^-?(\d+\.?\d*|\.\d+)/.exec(src.slice(i))!;
      tokens.push({t: 'num', v: Number(m[0]), pos: i});
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError('Unterminated string', i);
      tokens.push({t: 'str', v: src.slice(i + 1, end), pos: i});
      i = end + 1;
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_CHAR.test(src[j])) j++;
      tokens.push({t: 'id', v: src.slice(i, j), pos: i});
      i = j;
    } else {
      throw new ExprError(`Unexpected '${c}'`, i);
    }
  }
  tokens.push({t: 'end', pos: src.length});
  return tokens;
}

const KEYWORDS: Record<string, PortValue | null> = {true: true, false: false, null: null};

/** Parse an expression, validating function names and argument counts. */
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let k = 0;
  const peek = () => tokens[k];
  const isPunct = (v: string) => {
    const tok = peek();
    return tok.t === 'punct' && tok.v === v;
  };
  const expect = (v: string) => {
    if (!isPunct(v)) throw new ExprError(`Expected '${v}'`, peek().pos);
    k++;
  };

  function expr(): Expr {
    const tok = peek();
    if (tok.t === 'num' || tok.t === 'str') {
      k++;
      return {kind: 'lit', value: tok.v};
    }
    if (tok.t !== 'id') {
      throw new ExprError(tok.t === 'end' ? 'Unexpected end of expression' : 'Expected a value', tok.pos);
    }
    k++;
    if (isPunct('(')) {
      const spec = FUNCTIONS[tok.v];
      if (!spec) throw new ExprError(`Unknown function '${tok.v}'`, tok.pos);
      k++;
      const args: Expr[] = [];
      if (!isPunct(')')) {
        args.push(expr());
        while (isPunct(',')) {
          k++;
          args.push(expr());
        }
      }
      expect(')');
      const [lo, hi] = spec.arity;
      if (args.length < lo || args.length > hi) {
        const want = lo === hi ? `${lo}` : hi === Infinity ? `at least ${lo}` : `${lo}–${hi}`;
        throw new ExprError(`${tok.v}() takes ${want} argument${lo === 1 && hi === 1 ? '' : 's'}`, tok.pos);
      }
      return {kind: 'call', fn: tok.v, args};
    }
    if (isPunct('.')) {
      const path: string[] = [];
      while (isPunct('.')) {
        k++;
        const part = peek();
        if (part.t !== 'id') throw new ExprError('Expected a name after "."', part.pos);
        path.push(part.v);
        k++;
      }
      const [output, ...fields] = path;
      return {kind: 'ref', blockId: tok.v, output, path: fields};
    }
    if (tok.v in KEYWORDS) return {kind: 'lit', value: KEYWORDS[tok.v]};
    throw new ExprError(`Unknown name '${tok.v}' — refer to an output as block.output`, tok.pos);
  }

  const result = expr();
  if (peek().t !== 'end') throw new ExprError('Unexpected input after expression', peek().pos);
  return result;
}

const cache = new Map<string, Expr | ExprError>();

/** Parse with memoisation (expressions are re-evaluated on every render). */
export function parseCached(src: string): Expr | ExprError {
  let hit = cache.get(src);
  if (!hit) {
    try {
      hit = parseExpr(src);
    } catch (error) {
      hit = error instanceof ExprError ? error : new ExprError(String(error), 0);
    }
    cache.set(src, hit);
  }
  return hit;
}

// ---- Evaluation & inference ----

export type OutputLookup = (blockId: string, output: string) => PortValue | null | undefined;

export function evaluate(e: Expr, outputOf: OutputLookup): Value {
  switch (e.kind) {
    case 'lit':
      return e.value;
    case 'ref': {
      let v: any = outputOf(e.blockId, e.output) ?? null;
      for (const field of e.path) v = v == null ? null : (v[field] ?? null);
      return v;
    }
    case 'call': {
      const spec = FUNCTIONS[e.fn];
      const args = e.args.map((a) => evaluate(a, outputOf));
      if (!spec.nullAware && args.some((a) => a == null)) return null;
      try {
        const result = spec.call(...args);
        return typeof result === 'number' && !Number.isFinite(result) ? null : result;
      } catch {
        // A wrongly-shaped value (e.g. a bbox where a place was expected).
        return null;
      }
    }
  }
}

/** Evaluate source text; a parse error yields null. */
export function evaluateSource(src: string, outputOf: OutputLookup): Value {
  const parsed = parseCached(src);
  return parsed instanceof ExprError ? null : evaluate(parsed, outputOf);
}

export type PortTypeLookup = (blockId: string, output: string) => ValueType | undefined;

/** Best-effort static type of an expression (`any` when unknown). */
export function inferType(e: Expr, portType: PortTypeLookup): ValueType {
  switch (e.kind) {
    case 'lit':
      return e.value === null ? 'any' : typeof e.value;
    case 'ref':
      if (e.path.length > 0) return 'any';
      return portType(e.blockId, e.output) ?? 'any';
    case 'call':
      return FUNCTIONS[e.fn].type(e.args.map((a) => inferType(a, portType)));
  }
}

/** Every block output an expression reads (for the editor summary). */
export function refsOf(e: Expr): {blockId: string; output: string}[] {
  if (e.kind === 'ref') return [{blockId: e.blockId, output: e.output}];
  if (e.kind === 'call') return e.args.flatMap(refsOf);
  return [];
}
