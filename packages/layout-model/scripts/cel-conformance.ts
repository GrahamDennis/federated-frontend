/**
 * Run the official CEL conformance suite (github.com/google/cel-spec, via
 * @bufbuild/cel-spec's JSON export) against @marcbachmann/cel-js — the engine
 * behind our derived expressions — and write a report to
 * docs/cel-conformance.md.
 *
 *   npm run cel-conformance -w @ff/layout-model
 *
 * Tests needing protobuf messages, declared type environments or containers
 * are *skipped* (and counted): our bindings only exchange JSON-shaped values,
 * so those features aren't reachable from a layout expression.
 */
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Environment} from '@marcbachmann/cel-js';
import {tests as conformance} from '@bufbuild/cel-spec/testdata/conformance.js';

type Json = any;
interface Suite {
  name: string;
  suites?: Suite[];
  tests?: {original: Json}[];
}

class Skip extends Error {}

// ---- Canonical forms, so expected (protobuf JSON) and actual (cel-js) compare ----

function fromExpected(v: Json): unknown {
  if (v == null) throw new Skip('no value');
  if ('int64Value' in v) return {int: String(v.int64Value)};
  if ('uint64Value' in v) return {uint: String(v.uint64Value)};
  if ('doubleValue' in v) return {double: String(v.doubleValue)};
  if ('stringValue' in v) return {string: v.stringValue};
  if ('boolValue' in v) return v.boolValue;
  if ('nullValue' in v) return null;
  if ('bytesValue' in v) return {bytes: v.bytesValue};
  if ('typeValue' in v) return {type: v.typeValue};
  if ('listValue' in v) return (v.listValue.values ?? []).map(fromExpected);
  if ('mapValue' in v) {
    return {
      map: (v.mapValue.entries ?? [])
        .map((e: Json) => [JSON.stringify(fromExpected(e.key)), fromExpected(e.value)])
        .sort((a: [string], b: [string]) => a[0].localeCompare(b[0])),
    };
  }
  if ('objectValue' in v) throw new Skip('protobuf message value');
  if ('enumValue' in v) throw new Skip('enum value');
  throw new Skip(`value ${Object.keys(v).join(',')}`);
}

/** Expected binding values become the JS values cel-js expects as input. */
function toInput(v: Json): unknown {
  if ('int64Value' in v) return BigInt(v.int64Value);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('nullValue' in v) return null;
  if ('bytesValue' in v) return Uint8Array.from(Buffer.from(v.bytesValue, 'base64'));
  if ('listValue' in v) return (v.listValue.values ?? []).map(toInput);
  if ('mapValue' in v) {
    return new Map((v.mapValue.entries ?? []).map((e: Json) => [toInput(e.key), toInput(e.value)]));
  }
  throw new Skip(`binding ${Object.keys(v).join(',')}`);
}

function fromActual(v: any): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return {int: String(v)};
  if (typeof v === 'number') return {double: Number.isNaN(v) ? 'NaN' : String(v)};
  if (typeof v === 'string') return {string: v};
  if (typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return {bytes: Buffer.from(v).toString('base64')};
  const kind = v.constructor?.name;
  if (kind === 'UnsignedInteger' || kind === 'UnsignedInt') return {uint: String(v.value)};
  if (kind === 'Type') return {type: String(v).replace(/^Type<(.*)>$/, '$1')};
  if (Array.isArray(v)) return v.map(fromActual);
  const entries: [unknown, unknown][] = v instanceof Map ? [...v.entries()] : Object.entries(v);
  if (kind === 'Object' || kind === 'Map') {
    return {
      map: entries
        .map(([k, val]) => [
          JSON.stringify(typeof k === 'string' ? {string: k} : fromActual(k)),
          fromActual(val),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    };
  }
  throw new Skip(`result ${kind}`);
}

function canonicalDouble(x: unknown): unknown {
  // Expected doubles arrive as JSON numbers or "NaN"/"Infinity" strings.
  if (x && typeof x === 'object' && 'double' in x) {
    const n = Number((x as {double: string}).double);
    return {double: Number.isNaN(n) ? 'NaN' : String(n)};
  }
  if (Array.isArray(x)) return x.map(canonicalDouble);
  if (x && typeof x === 'object' && 'map' in x) {
    return {map: (x as {map: [string, unknown][]}).map.map(([k, v]) => [k, canonicalDouble(v)])};
  }
  return x;
}

// ---- Run ----

interface Result {
  section: string;
  name: string;
  outcome: 'pass' | 'fail' | 'skip';
  detail?: string;
}

function runTest(section: string, t: Json): Result {
  const name = t.name ?? t.expr;
  try {
    if (t.typeEnv?.length) throw new Skip('declared type environment');
    if (t.container) throw new Skip('container');
    if (t.checkOnly || t.typedResult) throw new Skip('type-check only');
    // `pkg.Message{field: …}`: constructs a protobuf message.
    if (/[A-Za-z_][\w.]*\s*\{/.test(t.expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'))) {
      throw new Skip('protobuf message construction');
    }
    // The same options as our layout environment (expressions.ts).
    const env = new Environment({
      unlistedVariablesAreDyn: true,
      enableOptionalTypes: true,
      homogeneousAggregateLiterals: false,
    });
    const bindings = Object.fromEntries(
      Object.entries(t.bindings ?? {}).map(([k, b]: [string, Json]) => {
        if (!b.value) throw new Skip('non-value binding');
        return [k, toInput(b.value)];
      }),
    );
    const expected = t.evalError ? 'error' : canonicalDouble(fromExpected(t.value ?? {boolValue: true}));
    let actual: unknown;
    try {
      actual = canonicalDouble(fromActual(env.evaluate(t.expr, bindings)));
    } catch (error) {
      if (error instanceof Skip) throw error;
      actual = 'error';
      if (expected !== 'error') {
        return {section, name, outcome: 'fail', detail: String((error as Error).message).split('\n')[0]};
      }
    }
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return pass
      ? {section, name, outcome: 'pass'}
      : {section, name, outcome: 'fail', detail: `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`};
  } catch (error) {
    if (error instanceof Skip) return {section, name, outcome: 'skip', detail: error.message};
    return {section, name, outcome: 'fail', detail: String(error)};
  }
}

const results: Result[] = [];
function walk(suite: Suite, section: string) {
  for (const t of suite.tests ?? []) results.push(runTest(section, t.original));
  for (const child of suite.suites ?? []) walk(child, section);
}
for (const top of (conformance as Suite).suites ?? []) walk(top, top.name);

// ---- Report ----

/**
 * Suites for optional extension libraries (cel-go's ext packages and the
 * two-variable comprehension / optional-type extensions), not the core spec.
 */
const EXTENSIONS = new Set([
  'bindings_ext',
  'block_ext',
  'encoders_ext',
  'math_ext',
  'string_ext',
  'macros2',
  'optionals',
]);
const sections = [...new Set(results.map((r) => r.section))];
const core = results.filter((r) => !EXTENSIONS.has(r.section));
const ext = results.filter((r) => EXTENSIONS.has(r.section));
const count = (rs: Result[], o: Result['outcome']) => rs.filter((r) => r.outcome === o).length;
const pct = (pass: number, fail: number) =>
  pass + fail === 0 ? '—' : `${Math.round((100 * pass) / (pass + fail))}%`;
const total = {pass: count(results, 'pass'), fail: count(results, 'fail'), skip: count(results, 'skip')};
const summary = (rs: Result[]) =>
  `${count(rs, 'pass')} passed, ${count(rs, 'fail')} failed, ${count(rs, 'skip')} skipped ` +
  `(${pct(count(rs, 'pass'), count(rs, 'fail'))} of applicable)`;

const lines = [
  '# CEL conformance: @marcbachmann/cel-js',
  '',
  'Generated by `npm run cel-conformance -w @ff/layout-model` from the official',
  '[cel-spec](https://github.com/google/cel-spec) conformance suite (via',
  '`@bufbuild/cel-spec`). Tests needing protobuf messages, declared type',
  'environments or containers are **skipped**. Layout expressions only exchange',
  'JSON-shaped values, so those features aren’t reachable from them.',
  '',
  `- **Core spec:** ${summary(core)}`,
  `- **Extension libraries** (${[...EXTENSIONS].join(', ')}): ${summary(ext)}.`,
  '  These are optional add-ons in cel-go; most aren’t implemented by cel-js.',
  '',
  '| Section | Pass | Fail | Skip | Pass rate |',
  '|---|---:|---:|---:|---:|',
  ...sections.map((s) => {
    const rs = results.filter((r) => r.section === s);
    const [p, f, k] = [count(rs, 'pass'), count(rs, 'fail'), count(rs, 'skip')];
    return `| ${s}${EXTENSIONS.has(s) ? ' *(ext)*' : ''} | ${p} | ${f} | ${k} | ${pct(p, f)} |`;
  }),
  '',
  '## Failures',
  '',
  'At most 10 per section. The full list is printed when the script runs.',
  '',
  ...sections.flatMap((s) => {
    const fails = results.filter((r) => r.section === s && r.outcome === 'fail');
    if (fails.length === 0) return [];
    return [
      `### ${s} (${fails.length})`,
      '',
      ...fails.slice(0, 10).map((r) => `- \`${r.name.replace(/`/g, "'")}\`: ${r.detail?.replace(/\|/g, '\\|')}`),
      ...(fails.length > 10 ? [`- … and ${fails.length - 10} more`] : []),
      '',
    ];
  }),
];

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/cel-conformance.md');
writeFileSync(out, lines.join('\n'));
for (const r of results.filter((r) => r.outcome === 'fail')) console.log(`FAIL [${r.section}] ${r.name}: ${r.detail}`);
console.log(`\n${total.pass} passed, ${total.fail} failed, ${total.skip} skipped → ${out}`);
