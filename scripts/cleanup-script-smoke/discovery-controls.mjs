/**
 * CleanUp1 §6.2 — PURE classification controls for the ONE canonical script
 * classifier.
 *
 * These controls exercise the ACTUAL `classifyTopLevel` / `topLevelExecutable`
 * exported by ./discover.mjs. They do not re-implement, wrap, or duplicate the
 * classifier (there is exactly one), and they NEVER import, mount, spawn or
 * otherwise physically execute a discovered script: every fixture below is an
 * IN-MEMORY source string handed straight to the pure classifier. "Classified
 * as an entrypoint" is a source-shape verdict, not a claim that anything ran.
 *
 * Obligations retained verbatim from the two pre-existing suites:
 *   - scripts/cleanup-gates/guard-config.test.mjs (the AST entrypoint
 *     classification test: 4 negative + 7 positive fixtures), and
 *   - the in-memory fixtures of `selfTest()` in ./run-smoke.mjs (5 fixtures).
 * Those sources are reproduced unchanged so the canonical classifier keeps
 * satisfying them; the remaining fixtures extend coverage to the semantics this
 * repair is about.
 *
 * PARSER POLICY: the fixtures below are AST obligations. If the pinned
 * TypeScript parser is unavailable, `classifyTopLevel` falls back to a
 * conservative scanner whose verdicts are NOT the subject of these controls, so
 * the run reports `NOT RUN` and exits non-zero instead of claiming a pass.
 *
 * Run: `node scripts/cleanup-script-smoke/discovery-controls.mjs`
 * Exit: 0 all controls pass; 1 a control failed; 2 parser unavailable (NOT RUN).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  classifyTopLevel,
  topLevelExecutable,
  astParserAvailable,
  tokenizeCommand,
  analyzeCommand,
  resolveDeclaredTargets,
  discoverEntrypoints,
  packageJsonInventory,
  classifyDisposition,
} from './discover.mjs';

const JS = 'probe.mjs';
const TS = 'probe.ts';

/**
 * @typedef {{name:string, src:string, file:string, origin?:string}} Fixture
 */

/** Files that must classify as a pure helper (executable === false). */
const HELPERS = /** @type {Fixture[]} */ ([
  // --- retained: guard-config.test.mjs (negative) ---
  { origin: 'guard-config.test.mjs', name: 'imports / function / pure class are declarations-only', file: JS, src: 'import fs from "node:fs";\nexport function f() { return 1; }\nclass C { m() {} }\n' },
  { origin: 'guard-config.test.mjs', name: 'a pure export-assignment object is declarations-only', file: JS, src: 'export default { a: 1, b: 2 };\n' },
  { origin: 'guard-config.test.mjs', name: 'a constant enum is declarations-only', file: TS, src: 'enum E { A, B }\n' },
  { origin: 'guard-config.test.mjs', name: 'a namespace of pure const declarations is declarations-only', file: TS, src: 'namespace N { export const x = 1; }\n' },
  // --- retained: run-smoke selfTest ---
  { origin: 'run-smoke.selfTest', name: 'declarations-only file is a module', file: JS, src: 'export const a = 1;\nexport function b() {}\n' },
  // --- class: deferred vs definition-time ---
  { name: 'static pure (literal) initializer is a helper', file: JS, src: 'class C { static x = 1; }\n' },
  { name: 'instance property initializer is DEFERRED (a helper)', file: JS, src: 'class C { x = work(); }\n' },
  { name: 'instance method body is DEFERRED (a helper)', file: JS, src: 'class C { m() { work(); } }\n' },
  { name: 'static method body is DEFERRED (a helper)', file: JS, src: 'class C { static m() { work(); } }\n' },
  { name: 'a pure computed class key is a helper', file: JS, src: 'class C { [Symbol.iterator]() {} }\n' },
  { name: 'export default pure class is a helper', file: JS, src: 'export default class { m() {} }\n' },
  // --- deferred function / arrow bodies ---
  { name: 'arrow body is DEFERRED (a helper)', file: JS, src: 'const f = () => work();\n' },
  { name: 'function-expression body is DEFERRED (a helper)', file: JS, src: 'const f = function () { work(); };\n' },
  { name: 'object-literal method body is DEFERRED (a helper)', file: JS, src: 'const o = { m() { work(); } };\n' },
  { name: 'object-literal getter body is DEFERRED (a helper)', file: JS, src: 'const o = { get x() { return work(); } };\n' },
  // --- enum constants ---
  { name: 'enum with numeric constant initializers is a helper', file: TS, src: 'enum E { A = 1, B }\n' },
  { name: 'enum with a string constant initializer is a helper', file: TS, src: 'enum E { A = "x" }\n' },
  // --- namespaces ---
  { name: 'ambient declare-namespace is a helper', file: TS, src: 'declare namespace N { const x: number; }\n' },
  { name: 'namespace of only functions/types is a helper', file: TS, src: 'namespace N { export function f() {} export type T = number; }\n' },
  { name: 'an empty namespace is a helper', file: TS, src: 'namespace N {}\n' },
  // --- pure literals / exports ---
  { name: 'a plain template literal initializer is a helper', file: JS, src: 'const s = `plain`;\n' },
  { name: 'a pure computed object key is a helper', file: JS, src: 'const o = { [Symbol.iterator]: 1 };\n' },
  { name: 'export = <literal> is a helper', file: TS, src: 'export = 1;\n' },
  // --- round37: pure heritage / computed keys / deferred bodies (must stay helpers) ---
  { name: 'extends a PURE reference is a helper', file: JS, src: 'class C extends Base {}\n' },
  { name: 'extends a pure dotted reference is a helper', file: JS, src: 'class C extends ns.Base {}\n' },
  { name: 'a pure computed object method key is a helper', file: JS, src: 'const o = { [Symbol.iterator]() {} };\n' },
  { name: 'a pure constant computed object getter key is a helper', file: JS, src: 'const o = { get [KEY]() {} };\n' },
  { name: 'an object method body assignment is DEFERRED (a helper)', file: JS, src: 'const o = { m() { obj.x = 1; } };\n' },
  { name: 'an object getter body update is DEFERRED (a helper)', file: JS, src: 'const o = { get x() { return count++; } };\n' },
  { name: 'an arrow body delete is DEFERRED (a helper)', file: JS, src: 'const f = () => { delete obj.k; };\n' },
  { name: 'a function-expression body assignment is DEFERRED (a helper)', file: JS, src: 'const f = function () { obj.x = 1; };\n' },
  { name: 'an instance field assignment initializer is DEFERRED (a helper)', file: JS, src: 'class C { y = (obj.x = 1); }\n' },
  { name: 'an instance field delete initializer is DEFERRED (a helper)', file: JS, src: 'class C { y = delete obj.k; }\n' },
  { name: 'an instance field update initializer is DEFERRED (a helper)', file: JS, src: 'class C { y = count++; }\n' },
  // --- retained: run-smoke selfTest (malformed must NOT be helper) is in MALFORMED ---
]);

/** Files that must classify as an entrypoint (executable === true). */
const ENTRYPOINTS = /** @type {Fixture[]} */ ([
  { name: 'object binding default call evaluates work', file: TS, src: 'const { a = work() } = obj;\n' },
  { name: 'array binding default call evaluates work', file: TS, src: 'const [a = work()] = arr;\n' },
  { name: 'computed binding key evaluates work', file: TS, src: 'const { [key()]: a } = obj;\n' },
  { name: 'nested binding default update evaluates work', file: TS, src: 'const { a: [b = count++] } = obj;\n' },
  // --- retained: guard-config.test.mjs (positive) ---
  { origin: 'guard-config.test.mjs', name: 'export default <call> evaluates work', file: JS, src: 'export default main();\n' },
  { origin: 'guard-config.test.mjs', name: 'export default class with a static initializer evaluates work', file: JS, src: 'export default class { static x = work(); }\n' },
  { origin: 'guard-config.test.mjs', name: 'static property initializer evaluates work', file: JS, src: 'class C { static x = compute(); }\n' },
  { origin: 'guard-config.test.mjs', name: 'static block evaluates work', file: JS, src: 'class C { static { run(); } }\n' },
  { origin: 'guard-config.test.mjs', name: 'non-constant enum member initializer evaluates work', file: TS, src: 'enum E { A = sideEffect(), B }\n' },
  { origin: 'guard-config.test.mjs', name: 'namespace body execution is an entrypoint', file: TS, src: 'namespace N { run(); }\n' },
  { origin: 'guard-config.test.mjs', name: 'a computed object key evaluates work', file: JS, src: 'const o = { [key()]: 1 };\n' },
  // --- retained: run-smoke selfTest ---
  { origin: 'run-smoke.selfTest', name: 'renamed top-level run() is executable', file: JS, src: 'async function run() {}\nrun();\n' },
  { origin: 'run-smoke.selfTest', name: 'const initializer call is executable', file: JS, src: 'const x = run();\n' },
  { origin: 'run-smoke.selfTest', name: 'assignment call is executable', file: JS, src: 'let x;\nx = run();\n' },
  // --- class: definition-time effects ---
  { name: 'computed class method name evaluates work at definition', file: TS, src: 'class C { [key()]() {} }\n' },
  { name: 'computed STATIC field key evaluates work at definition', file: JS, src: 'class C { static [key()] = 1; }\n' },
  { name: 'computed INSTANCE field key evaluates work at definition', file: JS, src: 'class C { [key()] = 1; }\n' },
  { name: 'class decorator evaluates work at definition', file: TS, src: '@dec class C {}\n' },
  { name: 'member decorator evaluates work at definition', file: TS, src: 'class C { @dec m() {} }\n' },
  { name: 'static block with any body runs at definition', file: JS, src: 'class C { static { } }\n' },
  // --- enum / namespace ---
  { name: 'enum call initializer evaluates work', file: TS, src: 'enum E { A = f(), B }\n' },
  { name: 'namespace local const initializer call evaluates work', file: TS, src: 'namespace N { const y = f(); }\n' },
  { name: 'nested namespace execution evaluates work', file: TS, src: 'namespace A.B { run(); }\n' },
  // --- export forms ---
  { name: 'export = <call> evaluates work', file: TS, src: 'export = main();\n' },
  { name: 'export default class with a static block evaluates work', file: JS, src: 'export default class { static { run(); } }\n' },
  // --- expressions / templates / assignments ---
  { name: 'template interpolation call evaluates work', file: JS, src: 'const s = `x ${work()}`;\n' },
  { name: 'template interpolation member call evaluates work', file: JS, src: 'const s = `v=${obj.get()}`;\n' },
  { name: 'member assignment call evaluates work', file: JS, src: 'obj.foo = work();\n' },
  { name: 'top-level bare call evaluates work', file: JS, src: 'run();\n' },
  { name: 'top-level new evaluates work', file: JS, src: 'new Foo();\n' },
  { name: 'top-level await evaluates work', file: JS, src: 'await run();\n' },
  { name: 'tagged template statement evaluates work', file: JS, src: 'tag`x`;\n' },
  { name: 'immediately-invoked arrow evaluates work', file: JS, src: '(() => work())();\n' },
  { name: 'object spread of a call evaluates work', file: JS, src: 'const o = { ...work() };\n' },
  { name: 'array element call evaluates work', file: JS, src: 'const a = [work()];\n' },
  // --- round37: EXACT definition/evaluation-time effect probes + nearby forms ---
  { name: 'class extends CALL heritage evaluates work', file: JS, src: 'class C extends factory() {}\n' },
  { name: 'class expression with call heritage evaluates work', file: JS, src: 'const C = class extends factory() {};\n' },
  { name: 'export default class with call heritage evaluates work', file: JS, src: 'export default class extends factory() {}\n' },
  { name: 'computed object METHOD key evaluates work', file: JS, src: 'const o = { [key()]() {} };\n' },
  { name: 'computed object GETTER key evaluates work', file: JS, src: 'const o = { get [key()]() { return 1; } };\n' },
  { name: 'computed object SETTER key evaluates work', file: JS, src: 'const o = { set [key()](v) {} };\n' },
  { name: 'postfix ++ initializer evaluates work', file: JS, src: 'const n = count++;\n' },
  { name: 'postfix -- initializer evaluates work', file: JS, src: 'const n = count--;\n' },
  { name: 'prefix ++ initializer evaluates work', file: JS, src: 'const n = ++count;\n' },
  { name: 'prefix -- initializer evaluates work', file: JS, src: 'const n = --count;\n' },
  { name: 'member assignment initializer evaluates work', file: JS, src: 'const n = (obj.value = 1);\n' },
  { name: 'compound assignment initializer evaluates work', file: JS, src: 'const n = (obj.value += 1);\n' },
  { name: 'nullish assignment initializer evaluates work', file: JS, src: 'const n = (obj.a ??= 1);\n' },
  { name: 'delete initializer evaluates work', file: JS, src: 'const n = delete obj.key;\n' },
  { name: 'export const assignment initializer evaluates work', file: JS, src: 'export const n = (obj.value = 1);\n' },
  { name: 'static field assignment initializer evaluates work', file: JS, src: 'class C { static y = (obj.x = 1); }\n' },
  { name: 'static field update initializer evaluates work', file: JS, src: 'class C { static y = count++; }\n' },
  { name: 'delete inside a computed object key evaluates work', file: JS, src: 'const o = { [delete obj.k]: 1 };\n' },
  { name: 'update inside a computed class key evaluates work', file: JS, src: 'class C { [count++]() {} }\n' },
  { name: 'nested class expression with executable heritage evaluates work', file: JS, src: 'class A extends (class extends factory() {}) {}\n' },
]);

/** Malformed / unsupported source must FAIL CLOSED as executable. */
const MALFORMED = /** @type {Fixture[]} */ ([
  { origin: 'run-smoke.selfTest', name: 'malformed source defaults to executable', file: JS, src: 'function ( { ]\n' },
  { name: 'malformed export const initializer is executable (fail closed)', file: JS, src: 'export const x = ;\n' },
  { name: 'unbalanced class body is executable (fail closed)', file: JS, src: 'class C {\n' },
  { name: 'unbalanced namespace body is executable (fail closed)', file: TS, src: 'namespace N {\n' },
]);

/** Unknown-but-valid top-level constructs must FAIL CLOSED (certainty unsupported). */
const UNKNOWN = /** @type {Fixture[]} */ ([
  { name: 'top-level debugger statement is unsupported (fail closed)', file: JS, src: 'debugger;\n' },
  { name: 'top-level throw is unsupported (fail closed)', file: JS, src: "throw new Error('x');\n" },
]);

/** Certainty-tagged fixtures (the specific verdict, not just the boolean). */
const CERTAINTY = /** @type {Array<Fixture & {certainty:string}>} */ ([
  { name: 'pure declarations file certainty', file: JS, src: 'import fs from "node:fs";\nexport function f() {}\n', certainty: 'declarations-only' },
  { name: 'top-level execution certainty', file: JS, src: 'run();\n', certainty: 'execution' },
  { name: 'export default class static initializer certainty', file: JS, src: 'export default class { static x = work(); }\n', certainty: 'execution' },
  { name: 'namespace execution certainty', file: TS, src: 'namespace N { run(); }\n', certainty: 'execution' },
  { name: 'pure namespace certainty', file: TS, src: 'namespace N { export const x = 1; }\n', certainty: 'declarations-only' },
  { name: 'decorator certainty', file: TS, src: '@dec class C {}\n', certainty: 'execution' },
  { name: 'deferred instance initializer certainty', file: JS, src: 'class C { x = work(); }\n', certainty: 'declarations-only' },
  { name: 'malformed source certainty', file: JS, src: 'function ( { ]\n', certainty: 'unsupported' },
  { name: 'extends call heritage certainty', file: JS, src: 'class C extends factory() {}\n', certainty: 'execution' },
  { name: 'computed object method key certainty', file: JS, src: 'const o = { [key()]() {} };\n', certainty: 'execution' },
  { name: 'postfix update certainty', file: JS, src: 'const n = count++;\n', certainty: 'execution' },
  { name: 'assignment certainty', file: JS, src: 'const n = (obj.value = 1);\n', certainty: 'execution' },
  { name: 'delete certainty', file: JS, src: 'const n = delete obj.key;\n', certainty: 'execution' },
  { name: 'extends pure reference certainty', file: JS, src: 'class C extends Base {}\n', certainty: 'declarations-only' },
  { name: 'pure computed object method key certainty', file: JS, src: 'const o = { [Symbol.iterator]() {} };\n', certainty: 'declarations-only' },
  { name: 'deferred instance field assignment certainty', file: JS, src: 'class C { y = (obj.x = 1); }\n', certainty: 'declarations-only' },
]);

/**
 * Bounded synthetic fixture repo exercising the command-aware target resolver.
 * Written to a fresh temp dir so file RESOLUTION is real (no in-memory fakes);
 * no command text is ever executed.
 */
function resolverFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-resolver-'));
  // `w` writes a file, creating EVERY parent directory recursively (the previous
  // fixture wrote `apps/api/package.json` before any directory existed, which
  // threw ENOENT and aborted the whole bounded suite before a single check ran).
  const w = (rel, content = 'export const x = 1;\n') => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const wj = (rel, obj) => w(rel, JSON.stringify(obj, null, 2) + '\n');
  wj('package.json', {
    name: 'capiro',
    scripts: {
      lint: 'eslint src --ext .ts',
      'pnpm-filter-cwd': 'pnpm --filter @capiro/defense-api exec tsx scripts/run.ts',
      'pnpm-dir-cwd': 'pnpm -C apps/api exec tsx scripts/z.ts',
      'glob-test': 'tsx --test src/**/*.spec.ts',
      'nested-cli': 'node packages/meriv2-core/scripts/canary.ts',
      gen: 'node dist/main.js',
      dep: 'node node_modules/jest/bin/jest.js',
      srv: 'tsx src/server.ts',
      dataarg: 'tsx scripts/parse.ts --artifact scripts/__data__/x.json --chamber HASC',
      dyn: 'tsx scripts/${PHASE}.ts',
      esc: 'tsx ../../outside/cli.ts',
      shell: 'bash scripts/do.sh',
      cfg: 'jest --config jest.e2e.config.cjs',
      // Unknown / pattern pnpm selector: the cwd context is UNRESOLVED, so the
      // operand must NOT fall back to the package dir and falsely resolve.
      'unknown-filter-cwd': 'pnpm --filter @missing exec tsx scripts/check.ts',
      // A real `cd` segment changes the cwd of the FOLLOWING segment.
      'cd-cwd': 'cd apps/api && tsx scripts/z.ts',
      // A `cd` that escapes the root leaves the context unresolved (no wrong-cwd).
      'cd-escape': 'cd ../../outside && tsx scripts/nope.ts',
      // ts-node is a general TS executable, not a build tool.
      'tsnode-cli': 'ts-node tools/migrate.ts',
      // A `start:*` script label is NOT server evidence.
      'start-migrate': 'tsx tools/migrate.ts',
      // A positional source operand owned by an actual configured test runner.
      'jest-arbitrary': 'jest src/arbitrary.ts',
      // cdk LAUNCHES a ts-node app: build ownership comes from the OUTER context.
      'cdk-app': 'cdk synth --app "ts-node bin/app.ts"',
    },
  });
  wj('apps/api/package.json', {
    name: '@capiro/api',
    scripts: {
      'run-cli': 'tsx scripts/cli.ts',
      missing: 'tsx scripts/gone.ts',
      'jest-one': 'jest --runInBand src/feature.spec.ts',
      // language-owned Python CLI: ONE file, TWO exact command references.
      'extract:florida-legislative-directories': 'python scripts/extract-florida-legislative-directories.py',
      'verify:florida-legislative-directories': 'python scripts/extract-florida-legislative-directories.py --check',
    },
  });
  w('apps/api/scripts/cli.ts', "const a = process.argv.slice(2);\nif (a.length === 0) { console.error('usage: cli'); process.exit(2); }\n");
  w('apps/api/scripts/z.ts', 'run();\n');
  // A real Python source launched by an actual interpreter — NOT parsed as TS/JS.
  w('apps/api/scripts/extract-florida-legislative-directories.py', 'import argparse\n\nif __name__ == "__main__":\n    print("extract florida legislative directories")\n');
  w('apps/api/src/feature.spec.ts', 'it("x", () => {});\n');
  w('apps/defense-api/package.json', JSON.stringify({ name: '@capiro/defense-api' }, null, 2) + '\n');
  w('apps/defense-api/scripts/run.ts', 'run();\n');
  w('packages/meriv2-core/scripts/canary.ts', 'run();\n');
  w('scripts/do.sh', 'echo hi\n');
  w('scripts/parse.ts', 'run();\n');
  w('scripts/check.ts', 'run();\n');
  w('tools/migrate.ts', 'run();\n');
  w('src/arbitrary.ts', 'run();\n');
  w('bin/app.ts', 'run();\n');
  w('jest.e2e.config.cjs', 'module.exports = {};\n');
  w('dist/main.js', 'run();\n');
  return root;
}

/**
 * Source-backed fixture for the invocation-context (cwd) provenance controls.
 * ONE physical operational CLI (`apps/api/scripts/tool.mjs`) is declared from
 * FOUR distinct declaration contexts (the root package cwd, a `cd` segment, a
 * pnpm `--filter` selection and the api package itself) so the discovered entry
 * must retain ALL four. It also carries a walked declared entrypoint, a walked
 * destructive (unsafe) declared subject, an undeclared walked entrypoint and an
 * unknown/escaping cwd context. Written to a fresh temp dir so resolution is
 * real (no in-memory fakes); no command text is ever executed.
 */
function cwdContextFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-cwd-context-'));
  const w = (rel, content = 'export const x = 1;\n') => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const wj = (rel, obj) => w(rel, JSON.stringify(obj, null, 2) + '\n');
  wj('package.json', {
    name: '@probe/root',
    scripts: {
      // 1) root package cwd ('.') — the operand addressed from the repo root.
      'root-cwd': 'node apps/api/scripts/tool.mjs',
      // 2) a real `cd` segment propagates apps/api to the operand.
      'cd-cwd': 'cd apps/api && node scripts/tool.mjs',
      // 3) pnpm --filter selects the api package cwd for the operand.
      'filter-cwd': 'pnpm --filter @probe/api exec node scripts/tool.mjs',
      // 4) pnpm -C <dir> selects that directory as the operand cwd.
      'dir-cwd': 'pnpm -C apps/api exec node scripts/z.ts',
      // A nested command whose INNER filter cwd differs from the outer segment cwd.
      'nested-filter-cwd': 'cdk synth --app "pnpm --filter @probe/api exec node scripts/tool.mjs"',
      // Unknown --filter selector: the cwd context is UNRESOLVED (never guessed).
      'unknown-filter': 'pnpm --filter @missing exec node scripts/tool.mjs',
      // A `cd` that escapes the root leaves the cwd context UNRESOLVED.
      'cd-escape': 'cd ../../outside && node scripts/tool.mjs',
      // A WALKED apps/api/scripts *.ts subject that is ALSO declared operational.
      'walked-decl': 'node apps/api/scripts/tool.ts',
      // A WALKED destructive subject that is ALSO declared operational.
      'unsafe-decl': 'node apps/api/scripts/danger.ts',
    },
  });
  wj('apps/api/package.json', {
    name: '@probe/api',
    scripts: {
      // The 4th declaration of the SAME physical path, from the api package cwd.
      'local-cwd': 'node scripts/tool.mjs',
    },
  });
  w('apps/api/scripts/tool.mjs', 'run();\n');
  w('apps/api/scripts/tool.ts', 'run();\n');
  w('apps/api/scripts/plain.ts', 'run();\n');
  w('apps/api/scripts/z.ts', 'run();\n');
  w('apps/api/scripts/danger.ts', 'import { rmSync } from "node:fs";\nrmSync("/tmp/x", { recursive: true });\n');
  return root;
}

/**
 * Bounded controls for the command-aware declared-target resolver
 * (discovery715). Each check invokes the ACTUAL exported helpers on a real
 * synthetic filesystem fixture — never a phrase/regex imitation. Covers every
 * demonstrated category: extension-value fragments, pnpm filter/-C cwd, globs,
 * generated outputs, runner configs, dependency runners, runtime servers, real
 * nested operational CLIs, data-file arguments, shell operands, unknown/dynamic
 * refusal and genuinely-missing mandatory targets.
 */
export function runResolverControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ group: 'resolver', name, ok: !!ok, detail });
  const root = resolverFixture();

  // ---- quote-aware tokenisation (no execution) ----------------------------
  {
    const toks = tokenizeCommand('node "a b.ts" && tsx c.ts');
    const words = toks.filter((t) => t.type === 'word').map((t) => t.value);
    const ops = toks.filter((t) => t.type === 'op').map((t) => t.value);
    add('tokeniser keeps a quoted path as ONE token and splits on the operator',
      words.length === 4 && words[1] === 'a b.ts' && ops.length === 1 && ops[0] === '&&', JSON.stringify({ words, ops }));
  }

  // ---- extension-value fragment is NOT a file target ----------------------
  {
    const a = analyzeCommand({ command: 'eslint src --ext .ts', packageName: 'capiro', packageDir: root, root, cwdDir: root });
    const { records } = resolveDeclaredTargets(root);
    const fictitious = records.some((r) => r.token === '.ts' || r.rel === 'apps/api/.ts');
    add('a bare extension option value (`eslint src --ext .ts`) is NOT a file target',
      a.targets.length === 0 && a.ignored.some((i) => i.role === 'extension-value' && i.token === '.ts') && !fictitious,
      JSON.stringify({ targets: a.targets.length, ignored: a.ignored }));
  }

  // ---- correct pnpm --filter / -C cwd context -----------------------------
  {
    const { records } = resolveDeclaredTargets(root);
    const f = records.find((r) => r.reference === 'capiro#pnpm-filter-cwd');
    add('pnpm --filter exec resolves the operand against the SELECTED package cwd',
      !!f && f.rel === 'apps/defense-api/scripts/run.ts' && f.cwdSource === 'filter' && f.disposition === 'operational-cli',
      JSON.stringify(f && { rel: f.rel, cwdSource: f.cwdSource }));
    const d = records.find((r) => r.reference === 'capiro#pnpm-dir-cwd');
    add('pnpm -C <dir> exec resolves the operand against that dir',
      !!d && d.rel === 'apps/api/scripts/z.ts' && d.cwdSource === 'dir',
      JSON.stringify(d && { rel: d.rel, cwdSource: d.cwdSource }));
  }

  // ---- glob/dynamic operand stays explicitly unresolved --------------------
  {
    const { records } = resolveDeclaredTargets(root);
    const g = records.find((r) => r.reference === 'capiro#glob-test');
    add('a test glob stays unresolved but keeps its test-runner owner',
      !!g && g.resolution === 'dynamic' && g.disposition === 'test-runner-target', JSON.stringify(g && { resolution: g.resolution, disposition: g.disposition }));
    const dyn = records.find((r) => r.reference === 'capiro#dyn');
    add('a shell-interpolated CLI operand stays explicitly unresolved (operational-cli)',
      !!dyn && dyn.resolution === 'dynamic' && dyn.disposition === 'operational-cli', JSON.stringify(dyn && { resolution: dyn.resolution, disposition: dyn.disposition }));
    const esc = records.find((r) => r.reference === 'capiro#esc');
    add('an operand that escapes the root is refused (escapes-root)',
      !!esc && esc.resolution === 'escapes-root' && esc.rel === null, JSON.stringify(esc && { resolution: esc.resolution, rel: esc.rel }));
  }

  // ---- symlink is refused conservatively ----------------------------------
  {
    const a = analyzeCommand({
      command: 'tsx scripts/sym.ts', packageName: 'capiro', packageDir: root, root, cwdDir: root,
      stat: (p) => (String(p).endsWith('sym.ts') ? { exists: true, isSymlink: true } : { exists: false }),
    });
    add('a symlinked operand is refused conservatively (no silent resolution)',
      a.targets.length === 1 && a.targets[0].resolution === 'symlink', JSON.stringify(a.targets[0] && { resolution: a.targets[0].resolution }));
  }

  // ---- data-file argument is NOT a code entrypoint ------------------------
  {
    const { records } = resolveDeclaredTargets(root);
    const dataArg = records.find((r) => r.reference === 'capiro#dataarg');
    const anyData = records.some((r) => String(r.token).includes('__data__'));
    add('a `--artifact <data.json>` argument is not treated as a code entrypoint',
      !!dataArg && dataArg.rel === 'scripts/parse.ts' && !anyData, JSON.stringify({ dataarg: dataArg && dataArg.rel, anyData }));
  }

  // ---- pure disposition table (each demonstrated category) ----------------
  {
    const cat = (o) => classifyDisposition(o).disposition;
    const rows = [
      ['generated build output', cat({ rel: 'apps/api/dist/main.js', runner: 'node' }), 'generated-build-output'],
      ['dependency runner binary', cat({ rel: 'apps/api/node_modules/jest/bin/jest.js', runner: 'node' }), 'dependency-runner'],
      ['runner config', cat({ rel: 'apps/api/jest.e2e.config.cjs', runner: 'jest' }), 'runner-config'],
      ['runtime server', cat({ rel: 'apps/api/src/main.ts', runner: 'node' }), 'runtime-server'],
      ['test-runner target', cat({ rel: 'apps/api/src/feature.spec.ts', runner: 'jest' }), 'test-runner-target'],
      ['test directory operand', cat({ rel: 'packages/meriv2-core/test/evals/run.ts', runner: 'tsx' }), 'test-runner-target'],
      ['shell-script operand', cat({ rel: 'scripts/do.sh', runner: 'bash' }), 'shell-script'],
      // A build runner (cdk) is an actual build tool. A bare ts-node runner is NOT
      // (it is a general TS executable); cdk's `--app "ts-node ..."` operand is
      // build-owned through the OUTER command context instead.
      ['build tool operand (actual build runner)', cat({ rel: 'infra/cdk/bin/x.ts', runner: 'cdk' }), 'build-artifact'],
      ['standalone ts-node is a general TS executable, NOT build-owned', cat({ rel: 'tools/migrate.ts', runner: 'ts-node', scriptName: 'migrate', resolution: 'resolved' }), 'operational-cli'],
      ['cdk --app nested ts-node operand is build-owned via OUTER context', cat({ rel: 'infra/cdk/bin/x.ts', runner: 'ts-node', contextRunner: 'cdk' }), 'build-artifact'],
      ['tsx operand under a start:* script label stays operational (not server)', cat({ rel: 'tools/migrate.ts', runner: 'tsx', scriptName: 'start:migrate' }), 'operational-cli'],
      ['jest positional source owned by the test runner is test-owned', cat({ rel: 'src/arbitrary.ts', runner: 'jest' }), 'test-runner-target'],
      ['a non-server file named index run by eslint is NOT server-hidden', cat({ rel: 'apps/api/src/index.ts', runner: 'eslint' }), 'lint-target'],
      ['operational CLI source', cat({ rel: 'apps/e2e/scripts/guard.mjs', runner: 'node' }), 'operational-cli'],
      ['missing in-scope CLI', cat({ rel: 'apps/api/scripts/x.ts', runner: 'tsx', resolution: 'missing' }), 'missing-cli'],
      ['missing out-of-scope CLI', cat({ rel: 'apps/e2e/scripts/x.ts', runner: 'tsx', resolution: 'missing' }), 'unresolved-missing'],
    ];
    for (const [label, got, want] of rows) add(`disposition: ${label}`, got === want, `got=${got} want=${want}`);
  }

  // ---- demonstrated defect fixtures (actual exported helpers, real fs) -----
  {
    // (3) `pnpm -C <dir> exec ...` must resolve against the directory. The previous
    // code lowercased `-C` to `-c` and compared it to `-C`, silently ignoring it.
    const dir = analyzeCommand({ command: 'pnpm -C apps/api exec tsx scripts/z.ts', packageName: 'capiro', packageDir: root, root, cwdDir: root });
    add('analyzeCommand recognises pnpm -C <dir> (not silently lowercased to -c)',
      dir.runner === 'tsx' && dir.cwdSource === 'dir' && dir.targets.length === 1 && dir.targets[0].rel === 'apps/api/scripts/z.ts',
      JSON.stringify({ runner: dir.runner, cwdSource: dir.cwdSource, rel: dir.targets[0] && dir.targets[0].rel }));

    // (4) an unknown --filter selector must FAIL CLOSED — never fall back to the
    // package dir and falsely resolve the operand.
    const uf = analyzeCommand({ command: 'pnpm --filter @missing exec tsx scripts/check.ts', packageName: 'capiro', packageDir: root, root, cwdDir: root });
    add('an unknown --filter selector leaves the cwd context UNRESOLVED (no false resolution)',
      uf.targets.length === 1 && uf.targets[0].resolution === 'unresolved-context' && uf.targets[0].rel === null,
      JSON.stringify({ ctx: uf.contextUnresolved, target: uf.targets[0] && { resolution: uf.targets[0].resolution, rel: uf.targets[0].rel } }));

    const { records: recs2 } = resolveDeclaredTargets(root);
    const ufr = recs2.find((r) => r.reference === 'capiro#unknown-filter-cwd');
    add('an unknown --filter selector operand is an unresolved operational CLI (never wrong-cwd)',
      !!ufr && ufr.resolution === 'unresolved-context' && ufr.disposition === 'operational-cli',
      JSON.stringify(ufr && { resolution: ufr.resolution, disposition: ufr.disposition }));

    // (4b) a real `cd <dir>` segment propagates its cwd to the following segment.
    const cdr = recs2.find((r) => r.reference === 'capiro#cd-cwd');
    add('a `cd <dir> && <cli>` segment propagates its cwd (no wrong-cwd)',
      !!cdr && cdr.rel === 'apps/api/scripts/z.ts' && cdr.cwdSource === 'cd',
      JSON.stringify(cdr && { rel: cdr.rel, cwdSource: cdr.cwdSource }));

    // (4c) a `cd` that escapes the root leaves the context unresolved.
    const cde = recs2.find((r) => r.reference === 'capiro#cd-escape');
    add('a `cd` that escapes the root leaves the context unresolved (fail closed)',
      !!cde && cde.resolution === 'unresolved-context' && cde.disposition === 'operational-cli',
      JSON.stringify(cde && { resolution: cde.resolution }));

    // (5) a standalone ts-node CLI is operational, not build-owned; (5b) a cdk
    // --app nested ts-node IS build-owned through the OUTER command context.
    const tn = recs2.find((r) => r.reference === 'capiro#tsnode-cli');
    add('a standalone ts-node CLI is discovered as an operational CLI (not build-owned)',
      !!tn && tn.disposition === 'operational-cli' && tn.rel === 'tools/migrate.ts',
      JSON.stringify(tn && { rel: tn.rel, disposition: tn.disposition }));
    const cdkApp = recs2.find((r) => r.reference === 'capiro#cdk-app');
    add('a cdk --app nested ts-node operand is build-owned via the OUTER context',
      !!cdkApp && cdkApp.disposition === 'build-artifact' && cdkApp.rel === 'bin/app.ts',
      JSON.stringify(cdkApp && { rel: cdkApp.rel, disposition: cdkApp.disposition, owner: cdkApp.owner }));

    // (6) a `start:*` script label is NOT server evidence.
    const sm = recs2.find((r) => r.reference === 'capiro#start-migrate');
    add('a `start:*` script label does NOT make an unknown CLI a runtime server',
      !!sm && sm.disposition === 'operational-cli', JSON.stringify(sm && { disposition: sm.disposition }));

    // (7) a positional source operand of an actual test runner is test-owned.
    const ja = recs2.find((r) => r.reference === 'capiro#jest-arbitrary');
    add('a jest positional source operand is test-owned (not executed as a standalone CLI)',
      !!ja && ja.disposition === 'test-runner-target' && ja.runner === 'jest',
      JSON.stringify(ja && { disposition: ja.disposition, runner: ja.runner }));

    // Option-value accounting is retained in the exported resolver result.
    const { ignored } = resolveDeclaredTargets(root);
    add('the exported resolver result retains the ignored extension-value accounting',
      ignored.some((i) => i.role === 'extension-value' && i.token === '.ts' && i.reference === 'capiro#lint'),
      JSON.stringify(ignored.filter((i) => i.role === 'extension-value')));
  }

  // ---- discovery reconciliation (all categories, via discoverEntrypoints) --
  {
    const found = discoverEntrypoints(root);
    const by = (rel) => found.find((x) => x.rel === rel);

    const nested = by('apps/defense-api/scripts/run.ts');
    add('a resolved nested/out-of-root operational CLI is INCLUDED as an executed entrypoint',
      !!nested && nested.kind === 'entrypoint' && String(nested.subject).startsWith('declared:'), JSON.stringify(nested && { kind: nested.kind, subject: nested.subject }));

    const walked = by('apps/api/scripts/cli.ts');
    add('a walked §6.2 CLI is still a mandatory entrypoint',
      !!walked && walked.kind === 'entrypoint' && walked.subject === 'apps/api/scripts', JSON.stringify(walked && { kind: walked.kind, subject: walked.subject }));

    const missing = by('apps/api/scripts/gone.ts');
    add('a genuinely missing in-scope CLI target keeps an undiscovered-declared failure packet',
      !!missing && missing.kind === 'undiscovered-declared' && missing.subject === 'declared-missing', JSON.stringify(missing && { kind: missing.kind, subject: missing.subject }));

    const dyn = found.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('capiro#dyn'));
    add('an unresolved dynamic CLI operand keeps an undiscovered-declared failure packet',
      !!dyn && dyn.kind === 'undiscovered-declared', JSON.stringify(dyn && { kind: dyn.kind, subject: dyn.subject }));

    const ufFound = found.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('capiro#unknown-filter-cwd'));
    add('an unknown --filter selector operand FAILS CLOSED (undiscovered-declared), never silently non-smoke',
      !!ufFound && ufFound.kind === 'undiscovered-declared', JSON.stringify(ufFound && { kind: ufFound.kind, subject: ufFound.subject }));

    const cdeFound = found.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('capiro#cd-escape'));
    add('a cd that escapes the root FAILS CLOSED (undiscovered-declared)',
      !!cdeFound && cdeFound.kind === 'undiscovered-declared', JSON.stringify(cdeFound && { kind: cdeFound.kind }));

    const test = by('apps/api/src/feature.spec.ts');
    add('a test-runner operand is recorded with explicit test-owner accounting (never executed)',
      !!test && test.kind === 'declared-non-smoke' && test.disposition === 'test-runner-target', JSON.stringify(test && { kind: test.kind, disposition: test.disposition }));

    const gen = found.find((x) => x.rel === 'dist/main.js');
    add('a generated build output is a non-smoke declaration record (outside §6.2)',
      !!gen && gen.kind === 'declared-non-smoke' && gen.disposition === 'generated-build-output', JSON.stringify(gen && { kind: gen.kind, disposition: gen.disposition }));

    const dep = found.find((x) => x.disposition === 'dependency-runner');
    add('a dependency runner binary is a non-smoke declaration record',
      !!dep && dep.kind === 'declared-non-smoke', JSON.stringify(dep && { kind: dep.kind }));

    const srv = found.find((x) => x.disposition === 'runtime-server');
    add('a runtime server target is a non-smoke declaration record (explicit outside-§6.2 disposition)',
      !!srv && srv.kind === 'declared-non-smoke', JSON.stringify(srv && { kind: srv.kind }));

    const cfg = found.find((x) => x.disposition === 'runner-config');
    add('a runner config operand is a non-smoke declaration record',
      !!cfg && cfg.kind === 'declared-non-smoke', JSON.stringify(cfg && { kind: cfg.kind }));

    const sh = found.find((x) => x.disposition === 'shell-script');
    add('a shell-script operand is a non-smoke declaration record',
      !!sh && sh.kind === 'declared-non-smoke', JSON.stringify(sh && { kind: sh.kind }));

    add('every declaration is visible (no declaration silently dropped)',
      ['apps/defense-api/scripts/run.ts', 'apps/api/src/feature.spec.ts', 'dist/main.js', '.ts'].every((needle) => needle !== '.ts' ? found.some((x) => x.rel === needle || String(x.token) === needle) : true),
      JSON.stringify(found.map((x) => x.rel)));
  }

  // ---- language-owned Python CLI (interpreter-aware disposition) -----------
  {
    const { records } = resolveDeclaredTargets(root);
    const py = records.filter((r) => String(r.rel).endsWith('extract-florida-legislative-directories.py'));
    add('a `python <x>.py` command resolves the .py file (reference retained, never dropped)',
      py.length === 2 && py.every((r) => r.resolution === 'resolved' && r.rel === 'apps/api/scripts/extract-florida-legislative-directories.py'),
      JSON.stringify(py.map((r) => ({ reference: r.reference, resolution: r.resolution, rel: r.rel }))));
    add('a resolved .py launched by an actual python interpreter is a python-script disposition',
      py.length === 2 && py.every((r) => r.disposition === 'python-script' && r.runner === 'python' && r.owner === 'python-interpreter'),
      JSON.stringify(py.map((r) => ({ runner: r.runner, owner: r.owner, disposition: r.disposition }))));

    // A .py SUFFIX is insufficient: only a recognised interpreter confers the
    // language-owned disposition. Every unknown/mismatched context must stay
    // unresolved/failing or conservative-operational — never laundered.
    const cat = (o) => classifyDisposition(o).disposition;
    add('`tsx foo.py` is NOT laundered into python-script (conservative operational)',
      cat({ rel: 'scripts/foo.py', runner: 'tsx', resolution: 'resolved' }) === 'operational-cli',
      cat({ rel: 'scripts/foo.py', runner: 'tsx', resolution: 'resolved' }));
    add('a versioned python interpreter (python3 / python3.11) is recognised',
      cat({ rel: 'scripts/foo.py', runner: 'python3', resolution: 'resolved' }) === 'python-script' &&
      cat({ rel: 'scripts/foo.py', runner: 'python3.11', resolution: 'resolved' }) === 'python-script',
      JSON.stringify([cat({ rel: 'scripts/foo.py', runner: 'python3', resolution: 'resolved' }), cat({ rel: 'scripts/foo.py', runner: 'python3.11', resolution: 'resolved' })]));
    add('a MISSING python target stays fail-closed (missing-cli / unresolved-missing)',
      cat({ rel: 'apps/api/scripts/x.py', runner: 'python', resolution: 'missing' }) === 'missing-cli' &&
      cat({ rel: 'scripts/x.py', runner: 'python', resolution: 'missing' }) === 'unresolved-missing',
      JSON.stringify([cat({ rel: 'apps/api/scripts/x.py', runner: 'python', resolution: 'missing' }), cat({ rel: 'scripts/x.py', runner: 'python', resolution: 'missing' })]));
    add('an unresolved/dynamic/symlink python context is NOT accepted (conservative operational, fails closed)',
      cat({ rel: null, runner: 'python', resolution: 'unresolved-context' }) === 'operational-cli' &&
      cat({ rel: 'scripts/foo.py', runner: 'python', resolution: 'dynamic' }) === 'operational-cli' &&
      cat({ rel: 'scripts/foo.py', runner: 'python', resolution: 'symlink' }) === 'operational-cli',
      JSON.stringify([cat({ rel: null, runner: 'python', resolution: 'unresolved-context' }), cat({ rel: 'scripts/foo.py', runner: 'python', resolution: 'dynamic' }), cat({ rel: 'scripts/foo.py', runner: 'python', resolution: 'symlink' })]));
    add('a resolved real TS operand is unchanged (still operational-cli)',
      cat({ rel: 'apps/api/scripts/cli.ts', runner: 'tsx', resolution: 'resolved' }) === 'operational-cli',
      cat({ rel: 'apps/api/scripts/cli.ts', runner: 'tsx', resolution: 'resolved' }));

    // Discovery reconciliation: the python CLI is retained as a declared-non-smoke
    // record (never an executed entrypoint subject).
    const found = discoverEntrypoints(root);
    const pyFound = found.filter((x) => String(x.rel).endsWith('extract-florida-legislative-directories.py'));
    add('the python CLI is retained as TWO declared-non-smoke records over ONE file',
      pyFound.length === 2 && pyFound.every((x) => x.kind === 'declared-non-smoke' && x.disposition === 'python-script' && x.owner === 'python-interpreter'),
      JSON.stringify(pyFound.map((x) => ({ kind: x.kind, disposition: x.disposition, declaredBy: x.declaredBy }))));
    add('the python CLI is NEVER promoted to an executed entrypoint subject',
      !found.some((x) => x.kind === 'entrypoint' && String(x.rel).endsWith('.py')),
      JSON.stringify(found.filter((x) => String(x.rel).endsWith('.py')).map((x) => ({ kind: x.kind, rel: x.rel }))));
  }

  // ---- nonregular source laundering (ACTUAL real-fs probe) -----------------
  // A path that merely LOOKS like source but is NOT a regular file (a DIRECTORY
  // named `directory-named.py`) must NEVER resolve as a source target. This
  // exercises the ACTUAL analyzeCommand / discoverEntrypoints over a real temp
  // filesystem — no injected stat, no phrase imitation.
  {
    const tdir = mkdtempSync(join(tmpdir(), 'cleanup-nonregular-'));
    // A DIRECTORY named like Python source.
    mkdirSync(join(tdir, 'directory-named.py'), { recursive: true });
    const probe = analyzeCommand({ command: 'python directory-named.py', packageName: 'probe', packageDir: tdir, root: tdir, cwdDir: tdir, scriptName: 'verify' });
    const tgt = probe.targets[0];
    add('a DIRECTORY named *.py is refused (explicit nonregular resolution, never python-script)',
      probe.targets.length === 1 && tgt.resolution === 'not-a-regular-file' && tgt.disposition !== 'python-script',
      JSON.stringify(tgt && { resolution: tgt.resolution, disposition: tgt.disposition }));

    // A genuine REGULAR .py launched by python keeps its language owner (unchanged).
    writeFileSync(join(tdir, 'real.py'), 'print("hi")\n');
    const py = analyzeCommand({ command: 'python real.py', packageName: 'probe', packageDir: tdir, root: tdir, cwdDir: tdir, scriptName: 'verify' });
    add('a genuine regular .py launched by python keeps its python-script language owner',
      py.targets.length === 1 && py.targets[0].resolution === 'resolved' && py.targets[0].disposition === 'python-script' && py.targets[0].owner === 'python-interpreter',
      JSON.stringify(py.targets[0] && { resolution: py.targets[0].resolution, disposition: py.targets[0].disposition }));

    // A genuine REGULAR TS target resolves unchanged (JS/TS smoke scope unchanged).
    writeFileSync(join(tdir, 'real.ts'), 'run();\n');
    const ts = analyzeCommand({ command: 'tsx real.ts', packageName: 'probe', packageDir: tdir, root: tdir, cwdDir: tdir, scriptName: 'verify' });
    add('a genuine regular .ts target resolves unchanged (operational-cli)',
      ts.targets.length === 1 && ts.targets[0].resolution === 'resolved' && ts.targets[0].disposition === 'operational-cli',
      JSON.stringify(ts.targets[0] && { resolution: ts.targets[0].resolution, disposition: ts.targets[0].disposition }));

    // A nonregular resolution never becomes language-owned / statically outside.
    add('classifyDisposition: a not-a-regular-file target is NEVER python-script/static',
      classifyDisposition({ rel: 'directory-named.py', runner: 'python', resolution: 'not-a-regular-file' }).disposition !== 'python-script',
      classifyDisposition({ rel: 'directory-named.py', runner: 'python', resolution: 'not-a-regular-file' }).disposition);

    // Discovery reconciliation: a declared `python <dir>.py` FAILS CLOSED.
    const droot = mkdtempSync(join(tmpdir(), 'cleanup-nonregular-disc-'));
    writeFileSync(join(droot, 'package.json'), JSON.stringify({ name: 'probe', scripts: { verify: 'python directory-named.py' } }));
    mkdirSync(join(droot, 'directory-named.py'), { recursive: true });
    const disc = discoverEntrypoints(droot);
    const pkt = disc.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('probe#verify'));
    add('discovery: a directory named *.py declared by python FAILS CLOSED (undiscovered-declared), never python-script',
      !!pkt && pkt.kind === 'undiscovered-declared' && pkt.disposition !== 'python-script',
      JSON.stringify(pkt && { kind: pkt.kind, disposition: pkt.disposition, resolution: pkt.resolution }));
  }

  // ---- invocation-context (cwd) provenance (source-backed synthetic files) --
  // The Root-reproduced defect: `resolveDeclaredTargets` kept all four reference
  // NAMES but every record lost its cwdRel, and `discoverEntrypoints` collapsed
  // the physical path to a `declaredBy` name list. These controls assert the
  // ACTUAL resolver/discovery outputs carry each declaration's effective cwd and
  // retain ALL declaration contexts for one physical path.
  {
    const croot = cwdContextFixture();
    const { records } = resolveDeclaredTargets(croot);
    const rec = (ref) => records.find((r) => r.reference === ref);

    // (a) package cwd — the repo-root package runs the operand at '.'.
    const rootCwd = rec('@probe/root#root-cwd');
    add('cwd provenance: a root package declaration carries cwdRel "." (package)',
      !!rootCwd && rootCwd.cwdRel === '.' && rootCwd.cwdSource === 'package' && rootCwd.rel === 'apps/api/scripts/tool.mjs',
      JSON.stringify(rootCwd && { cwdRel: rootCwd.cwdRel, cwdSource: rootCwd.cwdSource, rel: rootCwd.rel }));

    // (a2) the package-local declaration carries ITS OWN package cwd.
    const local = rec('@probe/api#local-cwd');
    add('cwd provenance: a package-local declaration carries its own package cwd',
      !!local && local.cwdRel === 'apps/api' && local.cwdSource === 'package' && local.rel === 'apps/api/scripts/tool.mjs',
      JSON.stringify(local && { cwdRel: local.cwdRel, cwdSource: local.cwdSource }));

    // (b) a valid `cd <dir>` propagates its cwd to the operand.
    const cd = rec('@probe/root#cd-cwd');
    add('cwd provenance: a valid `cd <dir>` propagates its cwd to the operand',
      !!cd && cd.cwdRel === 'apps/api' && cd.cwdSource === 'cd' && cd.rel === 'apps/api/scripts/tool.mjs',
      JSON.stringify(cd && { cwdRel: cd.cwdRel, cwdSource: cd.cwdSource, rel: cd.rel }));

    // (c) pnpm --filter / -C <dir> nested commands select the operand cwd.
    const flt = rec('@probe/root#filter-cwd');
    add('cwd provenance: pnpm --filter selects the package cwd for the operand',
      !!flt && flt.cwdRel === 'apps/api' && flt.cwdSource === 'filter' && flt.rel === 'apps/api/scripts/tool.mjs',
      JSON.stringify(flt && { cwdRel: flt.cwdRel, cwdSource: flt.cwdSource }));
    const dir = rec('@probe/root#dir-cwd');
    add('cwd provenance: pnpm -C <dir> selects that directory as the operand cwd',
      !!dir && dir.cwdRel === 'apps/api' && dir.cwdSource === 'dir' && dir.rel === 'apps/api/scripts/z.ts',
      JSON.stringify(dir && { cwdRel: dir.cwdRel, cwdSource: dir.cwdSource }));

    // (d) OPERAND-LOCAL nested cwd: a nested command's operand carries the NESTED
    // command's cwd (apps/api via its inner --filter), not the outer segment cwd
    // ('.'). This is exactly what a naive outer `analyzeCommand.cwdRel` would lose.
    const nested = rec('@probe/root#nested-filter-cwd');
    add('cwd provenance: a nested command operand carries the NESTED cwd (not the outer segment cwd)',
      !!nested && nested.cwdRel === 'apps/api' && nested.rel === 'apps/api/scripts/tool.mjs',
      JSON.stringify(nested && { cwdRel: nested.cwdRel, cwdSource: nested.cwdSource, rel: nested.rel }));

    // (e) unresolved / escaping cwd contexts are REFUSED: explicit null cwdRel
    // with the existing unresolved-context evidence retained (never a guessed cwd).
    const uf = rec('@probe/root#unknown-filter');
    add('cwd provenance: an unknown --filter selector leaves cwdRel null with unresolved evidence',
      !!uf && uf.cwdRel === null && uf.resolution === 'unresolved-context' && !!uf.contextUnresolved,
      JSON.stringify(uf && { cwdRel: uf.cwdRel, resolution: uf.resolution, contextUnresolved: uf.contextUnresolved }));
    const ce = rec('@probe/root#cd-escape');
    add('cwd provenance: a `cd` that escapes the root leaves cwdRel null with unresolved evidence',
      !!ce && ce.cwdRel === null && ce.resolution === 'unresolved-context' && !!ce.contextUnresolved,
      JSON.stringify(ce && { cwdRel: ce.cwdRel, resolution: ce.resolution, contextUnresolved: ce.contextUnresolved }));

    // (f) discovery retains ALL FOUR declarations of ONE physical path as a
    // deterministic, exact-deduplicated declaredContexts array — never collapsed.
    const found = discoverEntrypoints(croot);
    const tool = found.find((x) => x.rel === 'apps/api/scripts/tool.mjs');
    add('discovery: one physical path retains ALL FOUR distinct declaration contexts',
      !!tool && tool.kind === 'entrypoint' && Array.isArray(tool.declaredContexts) && tool.declaredContexts.length === 4,
      JSON.stringify(tool && { kind: tool.kind, declaredContexts: tool.declaredContexts && tool.declaredContexts.length }));
    add('discovery: declaredContexts binds reference/package/packageDir/script/scriptBody/command/token/role/runner/cwdRel/cwdSource/resolution/disposition',
      !!tool && tool.declaredContexts.every((c) =>
        typeof c.reference === 'string' && typeof c.package === 'string' && typeof c.packageDir === 'string' &&
        typeof c.script === 'string' && typeof c.scriptBody === 'string' && typeof c.command === 'string' &&
        typeof c.token === 'string' && typeof c.role === 'string' && typeof c.runner === 'string' &&
        'cwdRel' in c && typeof c.cwdSource === 'string' && typeof c.resolution === 'string' && typeof c.disposition === 'string'),
      JSON.stringify(tool && tool.declaredContexts));
    add('discovery: the four retained contexts carry the four distinct effective cwds',
      !!tool && JSON.stringify(tool.declaredContexts.map((c) => c.cwdRel).slice().sort()) === JSON.stringify(['.', 'apps/api', 'apps/api', 'apps/api']),
      JSON.stringify(tool && tool.declaredContexts.map((c) => ({ reference: c.reference, cwdRel: c.cwdRel }))));

    // (g) declaredBy compatibility: the legacy name list is unchanged and agrees
    // with the context references (same order, same set).
    add('discovery: declaredBy compatibility preserved (name list agrees with declaredContexts)',
      !!tool && Array.isArray(tool.declaredBy) && tool.declaredBy.length === 4 &&
      JSON.stringify(tool.declaredBy) === JSON.stringify(tool.declaredContexts.map((c) => c.reference)),
      JSON.stringify(tool && { declaredBy: tool.declaredBy }));

    // (h) determinism: two independent discovery runs are byte-identical.
    const tool2 = discoverEntrypoints(croot).find((x) => x.rel === 'apps/api/scripts/tool.mjs');
    add('discovery: declaredContexts is deterministic across independent discovery runs',
      !!tool && !!tool2 && JSON.stringify(tool.declaredContexts) === JSON.stringify(tool2.declaredContexts),
      undefined);

    // (i) a WALKED entrypoint that is also declared carries its declaredContexts.
    const walked = found.find((x) => x.rel === 'apps/api/scripts/tool.ts');
    add('discovery: a walked entrypoint carries its declared invocation contexts',
      !!walked && walked.kind === 'entrypoint' && Array.isArray(walked.declaredContexts) &&
      walked.declaredContexts.some((c) => c.reference === '@probe/root#walked-decl' && c.cwdRel === '.'),
      JSON.stringify(walked && { kind: walked.kind, declaredBy: walked.declaredBy, cwds: walked.declaredContexts && walked.declaredContexts.map((c) => c.cwdRel) }));

    // (j) an UNSAFE walked subject keeps its declaration contexts (classification
    // unchanged; the provenance is not lost).
    const unsafe = found.find((x) => x.rel === 'apps/api/scripts/danger.ts');
    add('discovery: an unsafe walked subject keeps its declared contexts (classification unchanged)',
      !!unsafe && unsafe.kind === 'unsafe' && Array.isArray(unsafe.declaredContexts) &&
      unsafe.declaredContexts.some((c) => c.reference === '@probe/root#unsafe-decl'),
      JSON.stringify(unsafe && { kind: unsafe.kind, cwds: unsafe.declaredContexts && unsafe.declaredContexts.map((c) => c.cwdRel) }));

    // (k) no-declaration behavior preserved: an undeclared walked entrypoint
    // invents NO owning package directory and NO declaredContexts.
    const plain = found.find((x) => x.rel === 'apps/api/scripts/plain.ts');
    add('discovery: an undeclared walked entrypoint keeps NO declaredBy/declaredContexts (no invented owner/cwd)',
      !!plain && plain.kind === 'entrypoint' && plain.declaredBy === undefined && plain.declaredContexts === undefined,
      JSON.stringify(plain && { kind: plain.kind, hasDeclaredBy: 'declaredBy' in plain, hasContexts: 'declaredContexts' in plain }));

    // (l) the unknown/escaping cwd operands still FAIL CLOSED (undiscovered-declared).
    const ufFound = found.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('@probe/root#unknown-filter'));
    add('discovery: an unknown --filter operand FAILS CLOSED (undiscovered-declared), cwd not guessed',
      !!ufFound && ufFound.kind === 'undiscovered-declared' && ufFound.resolution === 'unresolved-context',
      JSON.stringify(ufFound && { kind: ufFound.kind, resolution: ufFound.resolution }));
    const ceFound = found.find((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('@probe/root#cd-escape'));
    add('discovery: a root-escaping `cd` operand FAILS CLOSED (undiscovered-declared)',
      !!ceFound && ceFound.kind === 'undiscovered-declared' && ceFound.resolution === 'unresolved-context',
      JSON.stringify(ceFound && { kind: ceFound.kind, resolution: ceFound.resolution }));
  }

  // A native run may install Corepack under /src after its clean-tree check.
  // This generated cache must produce an untracked-input failure without
  // parsing its command, while another untracked manifest and a genuinely
  // missing committed CLI remain failures.
  {
    const repo = mkdtempSync(join(tmpdir(), 'cleanup-discovery-git-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'new'), { recursive: true });
    mkdirSync(join(repo, '.corepack-home', 'v1', 'pnpm', '9.12.0'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { real: 'node scripts/real.mjs', missing: 'node scripts/missing.mjs' } }));
    writeFileSync(join(repo, 'scripts', 'real.mjs'), "console.log('real');\n");
    writeFileSync(join(repo, 'apps', 'new', 'package.json'), JSON.stringify({ scripts: { rogue: 'node rogue.ts' } }));
    writeFileSync(join(repo, '.corepack-home', 'v1', 'pnpm', '9.12.0', 'package.json'), JSON.stringify({ scripts: { bundle: 'node bundle.ts' } }));
    const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    const initialized = git(['init']);
    const staged = git(['add', 'package.json', 'scripts/real.mjs']);
    add('provenance fixture: git index contains the committed inputs',
      initialized.status === 0 && staged.status === 0, JSON.stringify({ init: initialized.status, add: staged.status }));
    if (initialized.status === 0 && staged.status === 0) {
      const inventory = packageJsonInventory(repo);
      const tracked = inventory.tracked.map((p) => p.slice(repo.length + 1).replaceAll('\\', '/'));
      const untracked = inventory.untracked.map((p) => p.slice(repo.length + 1).replaceAll('\\', '/'));
      add('provenance: only indexed manifests define canonical commands',
        JSON.stringify(tracked) === JSON.stringify(['package.json']), JSON.stringify({ tracked, untracked }));
      add('provenance: untracked source and generated Corepack manifests are diagnosed',
        JSON.stringify(untracked) === JSON.stringify(['apps/new/package.json', '.corepack-home/v1/pnpm/9.12.0/package.json']),
        JSON.stringify({ tracked, untracked }));
      const found = discoverEntrypoints(repo);
      const missing = found.find((x) => x.rel === 'scripts/missing.mjs');
      const rogue = found.find((x) => x.rel === 'apps/new/package.json');
      add('provenance: a genuinely missing indexed CLI remains an undiscovered-declared failure',
        missing?.kind === 'undiscovered-declared' && missing?.subject === 'declared-missing', JSON.stringify(missing));
      add('provenance: an untracked manifest produces an explicit failure packet',
        rogue?.kind === 'undiscovered-declared' && rogue?.subject === 'untracked-input' && rogue?.disposition === 'untracked-manifest', JSON.stringify(rogue));
      const cache = found.find((x) => x.rel === '.corepack-home/v1/pnpm/9.12.0/package.json');
      add('provenance: generated Corepack cache is an explicit failure, never its declared bundle.ts CLI',
        cache?.kind === 'undiscovered-declared' && cache?.subject === 'untracked-input' &&
        !found.some((x) => String(x.rel).endsWith('bundle.ts')), JSON.stringify(cache));
    }
  }

  // The smoke runner uses a Gitless `git archive` stage. It must make the
  // identical cache decision even when git ls-files is unavailable there.
  {
    const stage = mkdtempSync(join(tmpdir(), 'cleanup-discovery-stage-'));
    mkdirSync(join(stage, '.corepack-home', 'v1', 'pnpm', '9.12.0'), { recursive: true });
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(stage, '.corepack-home', 'v1', 'pnpm', '9.12.0', 'package.json'), JSON.stringify({ scripts: { bundle: 'node bundle.ts' } }));
    const inventory = packageJsonInventory(stage);
    const cache = discoverEntrypoints(stage).find((x) => x.rel === '.corepack-home/v1/pnpm/9.12.0/package.json');
    add('provenance: Gitless archive stage still reports generated Corepack cache as untracked-input',
      inventory.tracked.length === 1 && inventory.untracked.length === 1 &&
      cache?.kind === 'undiscovered-declared' && cache?.subject === 'untracked-input',
      JSON.stringify({ tracked: inventory.tracked, untracked: inventory.untracked, cache }));
  }

  const failed = checks.filter((c) => !c.ok);
  return { module: 'discovery-resolver-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
}

/**
 * Run every pure classification control against the ACTUAL canonical
 * classifier. Returns a structured, JSON-serialisable result. Does not execute
 * any discovered script and does not touch the filesystem.
 */
export function runControls() {
  const parserAvailable = astParserAvailable();
  const results = [];

  const recordBoolean = (fixture, expected, verdict) => {
    const got = verdict.executable;
    results.push({
      group: expected ? 'entrypoint' : 'helper',
      name: fixture.name,
      origin: fixture.origin ?? 'round34',
      file: fixture.file,
      expected,
      got,
      certainty: verdict.certainty,
      ok: got === expected,
    });
  };

  if (parserAvailable) {
    for (const fixture of HELPERS) recordBoolean(fixture, false, classifyTopLevel(fixture.src, fixture.file));
    for (const fixture of ENTRYPOINTS) recordBoolean(fixture, true, classifyTopLevel(fixture.src, fixture.file));
    for (const fixture of MALFORMED) recordBoolean(fixture, true, classifyTopLevel(fixture.src, fixture.file));
    for (const fixture of UNKNOWN) recordBoolean(fixture, true, classifyTopLevel(fixture.src, fixture.file));
    for (const fixture of CERTAINTY) {
      const verdict = classifyTopLevel(fixture.src, fixture.file);
      results.push({
        group: 'certainty',
        name: fixture.name,
        file: fixture.file,
        expectedCertainty: fixture.certainty,
        gotCertainty: verdict.certainty,
        ok: verdict.certainty === fixture.certainty,
      });
    }
    // Backward-compatible boolean view must agree with the rich verdict (the
    // run-smoke selfTest drives THIS entry point).
    for (const fixture of [...HELPERS, ...ENTRYPOINTS]) {
      const rich = classifyTopLevel(fixture.src, fixture.file).executable;
      const bool = topLevelExecutable(fixture.src, fixture.file);
      results.push({
        group: 'boolean-view',
        name: `topLevelExecutable agrees for: ${fixture.name}`,
        file: fixture.file,
        ok: rich === bool,
      });
    }
  }

  // Resolver controls exercise the command-aware declared-target resolver on a
  // real synthetic filesystem fixture. They do NOT depend on the TypeScript
  // parser, so they always run.
  const resolver = runResolverControls();
  for (const c of resolver.checks) results.push({ group: c.group, name: c.name, ok: c.ok, detail: c.detail });

  const failed = results.filter((r) => !r.ok);
  return {
    schema: 'capiro.cleanup1-discovery-controls',
    schemaVersion: 1,
    parserAvailable,
    // A resolver failure is a REAL failure even when the AST parser is missing;
    // otherwise a missing parser only downgrades the AST obligations to NOT RUN.
    status: failed.length > 0 ? 'FAIL' : parserAvailable ? 'PASS' : 'NOT RUN',
    reason: failed.length > 0
      ? undefined
      : parserAvailable
        ? undefined
        : 'TypeScript parser unavailable — AST classification controls were NOT RUN (the scanner fallback is not the subject of these controls)',
    totals: {
      fixtures: HELPERS.length + ENTRYPOINTS.length + MALFORMED.length + UNKNOWN.length + CERTAINTY.length,
      checks: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: failed.length,
      resolverChecks: resolver.total,
    },
    results,
    resolver,
  };
}

function main() {
  const report = runControls();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'PASS') return;
  process.stderr.write(
    report.status === 'NOT RUN'
      ? 'discovery-controls: NOT RUN — pinned TypeScript parser unavailable; AST controls were not executed.\n'
      : `discovery-controls: FAIL — ${report.totals.failed} of ${report.totals.checks} checks failed.\n`,
  );
  process.exitCode = report.status === 'NOT RUN' ? 2 : 1;
}

if (process.argv[1]?.endsWith('discovery-controls.mjs')) main();
