#!/usr/bin/env node
/**
 * Owned probe: static route-contract derivation correctness + no-host-execution.
 *
 * Reproduces the THREE false values root proved on 2026-10-08 against the
 * round-4 contract.mjs (source SHA256 074154f8…):
 *   1. reordered + encoded spans resolved first/second instead of second/first
 *   2. a literal `$ {'fixed'}` span resolved to the argument, not the literal
 *   3. a raw `$ {id}` span was force-encoded instead of preserved
 * and extends coverage to reordered / repeated / unused parameters, raw vs
 * encoded segments, local constants, nested templates, string concatenation,
 * function declarations, imported aliases and unsupported expressions (which
 * MUST become an explicit obligation, never a guessed value).
 *
 * Fixtures are IN-MEMORY source strings. Nothing is written to the repo and no
 * repository module is imported, transpiled or executed. `resolveImport` is a
 * plain in-memory map for the imported-alias case.
 *
 * Exit 0 only when every case matches and every no-host-execution check holds.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContractSource, applyFnTemplate } from '../lib/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.resolve(HERE, '..');
const REPO = path.resolve(E2E, '..', '..');

const CONTRACT_SRC = readFileSync(path.join(E2E, 'lib', 'contract.mjs'), 'utf8');
const AST_SRC = readFileSync(path.join(E2E, 'lib', 'ast-routes.mjs'), 'utf8');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return null; } })();

// ── fixtures (in-memory) ────────────────────────────────────────────────────
// Each: { id, file, source, exportName, args, expected, expectUnresolved }
const FIXTURES = [
  { id: 'root-1-reordered-encoded', file: 'swapped.ts',
    source: "export const route = (first: string, second: string) => `/route/${encodeURIComponent(second)}/${encodeURIComponent(first)}`;",
    args: ['A/value', 'B value'], expected: '/route/B%20value/A%2Fvalue' },
  { id: 'root-2-literal-span', file: 'constant.ts',
    source: "export const route = (id: string) => `/route/${'fixed'}`;",
    args: ['A/value'], expected: '/route/fixed' },
  { id: 'root-3-raw-segment', file: 'raw.ts',
    source: "export const route = (id: string) => `/route/${id}`;",
    args: ['A/value'], expected: '/route/A/value' },
  // round-6 root-proven defects
  { id: 'root-6-encodeURI', file: 'encodeuri.ts',
    source: "export const route = (id: string) => `/route/${encodeURI(id)}`;",
    args: ['A/value?x=1'], expected: '/route/A/value?x=1' },
  { id: 'root-6-shadowed-local', file: 'shadow.ts',
    source: "const segment = 'outer';\nexport const route = (id: string) => { const segment = 'inner'; return `/route/${segment}`; };",
    args: ['unused'], expected: '/route/inner' },
  { id: 'root-6-malformed-diagnostics', file: 'malformed.ts',
    source: "export const route = (id: string) => `/route/${id}`; export const broken = ;",
    args: ['A'], expectNotOk: true },
  { id: 'reordered', file: 'reordered.ts',
    source: "export const route = (a: string, b: string, c: string) => `/x/${c}/${a}`;",
    args: ['A', 'B', 'C'], expected: '/x/C/A' },
  { id: 'repeated-encoded', file: 'repeated.ts',
    source: "export const route = (id: string) => `/x/${encodeURIComponent(id)}/${encodeURIComponent(id)}`;",
    args: ['A/value'], expected: '/x/A%2Fvalue/A%2Fvalue' },
  { id: 'unused-param', file: 'unused.ts',
    source: "export const route = (a: string, b: string) => `/only/${a}`;",
    args: ['X', 'Y'], expected: '/only/X' },
  { id: 'mixed-raw-encoded', file: 'mixed.ts',
    source: "export const route = (a: string, b: string) => `/m/${a}/${encodeURIComponent(b)}`;",
    args: ['A/value', 'B value'], expected: '/m/A/value/B%20value' },
  { id: 'local-const', file: 'localconst.ts',
    source: "const ROOT = '/root';\nexport const route = (id: string) => `${ROOT}/${encodeURIComponent(id)}`;",
    args: ['A/value'], expected: '/root/A%2Fvalue' },
  { id: 'nested-template', file: 'nested.ts',
    source: "export const route = (id: string) => `/a${`/b${encodeURIComponent(id)}`}`;",
    args: ['A/value'], expected: '/a/bA%2Fvalue' },
  { id: 'concatenation', file: 'concat.ts',
    source: "export const route = (id: string) => '/c/' + encodeURIComponent(id);",
    args: ['A/value'], expected: '/c/A%2Fvalue' },
  { id: 'function-declaration', file: 'fndecl.ts',
    source: "export function route(id: string) { return `/fd/${encodeURIComponent(id)}`; }",
    args: ['A/value'], expected: '/fd/A%2Fvalue' },
  { id: 'imported-alias', file: 'alias.ts',
    source: "import { ROOT } from './shared';\nexport const route = (id: string) => `${ROOT}/${encodeURIComponent(id)}`;",
    args: ['A/value'], expected: '/imported-root/A%2Fvalue',
    resolveImport: (name) => (name === 'ROOT' ? '/imported-root' : null) },
  { id: 'encoded-const-literal', file: 'enclit.ts',
    source: "export const route = (id: string) => `/lit/${encodeURIComponent('A/B')}`;",
    args: [], expected: '/lit/A%2FB' },
  { id: 'concat-constants', file: 'concatconst.ts',
    source: "export const R = '/x' + '/y';",
    exportName: 'R', args: [], expected: '/x/y', expectKind: 'string' },
  { id: 'object-of-builders', file: 'objfn.ts',
    source: "export const P = { staff: (staffId: string) => `/directory/staff/${encodeURIComponent(staffId)}` };",
    exportName: 'P', pick: (v) => v.props.staff, args: ['a b'], expected: '/directory/staff/a%20b' },
  { id: 'unsupported-expression', file: 'unsupported.ts',
    source: "export const route = (id: string) => `/u/${id.toUpperCase()}`;",
    args: ['a'], expectUnresolved: true },
];

const rows = [];
let failures = 0;
for (const f of FIXTURES) {
  const derived = deriveContractSource(f.file, f.source, { resolveImport: f.resolveImport });
  const name = f.exportName ?? 'route';
  const entry = derived.exports[name];
  const target = f.pick ? (entry ? f.pick(entry) : undefined) : entry;
  const applied = f.expectUnresolved ? null : applyFnTemplate(target, f.args ?? [], f.id);
  let ok;
  let note = '';
  if (f.expectNotOk) {
    // Malformed source MUST fail closed (ok:false with a parse-failure reason),
    // never return a partial route list.
    ok = derived.ok === false && typeof derived.reason === 'string' && /parse failure/.test(derived.reason);
    note = ok ? `fail-closed: ${derived.reason}` : `NOT fail-closed: ${JSON.stringify(derived)}`;
  } else if (f.expectUnresolved) {
    const unresolved = (derived.unresolvedExports ?? []).includes(name);
    const notGuessed = !entry && derived.ok;
    const reason = applyFnTemplate(undefined, f.args ?? [], f.id).reason;
    ok = unfinishedSafe(derived) && unresolved && notGuessed && typeof reason === 'string';
    note = ok ? `explicit obligation: unresolvedExports=${JSON.stringify(derived.unresolvedExports)}; applyFnTemplate reason present` : 'unsupported expression was NOT surfaced as an obligation';
  } else if (f.expectKind === 'string') {
    ok = entry && entry.kind === 'string' && entry.value === f.expected;
    note = ok ? `kind=string value=${entry.value}` : `expected string ${f.expected}`;
  } else {
    ok = applied && applied.value === f.expected;
    note = ok ? `applied=${applied.value}` : `applied=${JSON.stringify(applied)} expected=${f.expected}`;
  }
  if (!ok) failures++;
  rows.push({ id: f.id, ok, expected: f.expectUnresolved ? '(explicit obligation)' : f.expected, derived, applied, note });
}

function unfinishedSafe(d) { return d.ok === true; }

// ── no-host-execution static checks ─────────────────────────────────────────
// Strip comments first so a prose mention (e.g. the module header describing the
// REMOVED transpile/import path) is not mistaken for live code.
const CONTRACT_CODE = CONTRACT_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const FORBIDDEN = [
  { name: 'transpileModule', re: /transpileModule/ },
  { name: 'transpile()', re: /\btranspile\s*\(/ },
  { name: 'new Function()', re: /new\s+Function\s*\(/ },
  { name: 'eval()', re: /\beval\s*\(/ },
  { name: 'await import()', re: /await\s+import\s*\(/ },
  { name: "dynamic import('...')", re: /import\s*\(\s*['"`]/ },
  { name: 'child_process', re: /child_process/ },
];
const executionChecks = FORBIDDEN.map((c) => ({ name: c.name, absent: !c.re.test(CONTRACT_CODE) }));
executionChecks.push({ name: 'deriveContractSource exported', absent: /export function deriveContractSource/.test(CONTRACT_CODE) });
for (const c of executionChecks) if (!c.absent) failures++;

const result = {
  probe: 'apps/e2e/scripts/probe-static-contract.mjs',
  note: 'Owned in-memory probe; nothing written to the repo, no repository module imported/transpiled/executed.',
  repoHead: head,
  sourceSha256: {
    'apps/e2e/lib/contract.mjs': sha256(CONTRACT_SRC),
    'apps/e2e/lib/ast-routes.mjs': sha256(AST_SRC),
  },
  round4Reference: { 'contract.mjs': '074154f88addcd6c5ae9968b1d3bddfca65354d9db75c523021a17ff65f8002b' },
  executionChecks,
  cases: rows,
  pass: rows.filter((r) => r.ok).length,
  fail: rows.filter((r) => !r.ok).length,
};

const out = path.join(E2E, 'probe-static-contract-results.json');
import { writeFileSync } from 'node:fs';
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ pass: result.pass, fail: result.fail, executionChecks, sourceSha256: result.sourceSha256 }, null, 2));
if (failures) { console.error(`PROBE FAILED: ${failures} problem(s)`); process.exit(1); }
console.log(`OK — ${result.pass}/${rows.length} cases + ${executionChecks.length} no-execution checks`);
