import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import {
  parseContextPlaneInvocation, projectContextPlaneDiff, partitionContextPlaneDiff, assertContextPlaneReadPath,
  contextPlaneIncludesPath, contextPlaneSourceFilesUnder,
} from '../lib/context-plane-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = 'c8c109f7d796d5a50ae57ff6cb214d576c757847';
const path = 'scripts/check-context-plane-new-bypasses.mjs';
const before = (file) => execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' });
const original = before(path);
const current = readFileSync(join(root, path), 'utf8');
const hash = (source) => createHash('sha256').update(source).digest('hex');
assert.equal(hash(original), 'c42def8003206269bd21e5c127ded616c1ab3a194a671514f5e64e2a34021bd6');

// Bounded immutable backend source data, never application imports or SQL execution.
const sourcePaths = [...new Set([...original.matchAll(/['"]((?:apps|packages)\/[^'"]+\.(?:ts|tsx))['"]/g)].map((match) => match[1]))];
const seed = Object.fromEntries(sourcePaths.map((file) => [file, before(file)]));
seed['apps/web/src/safe.ts'] = 'export const safe = 1;';
seed['apps/onboard-web/src/safe.tsx'] = 'export const safe = 2;';
seed['packages/future-context/src/safe.ts'] = 'export const safe = 3;';
const policy = { skipDirectories: new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']), testSuffixes: ['.spec.ts', '.test.ts'] };

function legacyProjection(source) {
  let result = source.replace("import { readFileSync as readSourceFileSync, readdirSync, statSync, lstatSync } from 'node:fs';",
    "import { readFileSync, readdirSync, statSync } from 'node:fs';");
  result = result.replace(/^import \{ architectureGuardBase, guardRef \} from '\.\/cleanup-gates\/lib\/cli\.mjs';\nimport \{\n[\s\S]*?\} from '\.\/lib\/context-plane-scope\.mjs';[\s\S]*?(\n\/\*\*)/m,
    "import { architectureGuardBase } from './cleanup-gates/lib/cli.mjs';\n\nconst base = architectureGuardBase('check-context-plane-new-bypasses');\n$1");
  result = result.replace('diff = projectContextPlaneDiff(execFileSync(', 'diff = execFileSync(')
    .replace('  ), scope);', '  );');
  result = result.replaceAll("  if (scope !== 'full') console.error(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`);\n", '');
  result = result.replace("if (scope === 'full') {\nlet file = null;", 'let file = null;')
    .replace(`} else {
  for (const { path: file, additions } of partitionContextPlaneDiff(diff)) {
    if (IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    if (TEST_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    for (const added of additions) {
      if (isCommentOnly(added)) continue;
      if (isApproved(file, added)) continue;
      const matched = BANNED_ADDITION_PATTERNS.find((pattern) => pattern.test(added));
      if (matched) violations.push({ file, added: added.trim(), pattern: String(matched) });
    }
  }
}
`, '');
  result = result.replace("// Product adoption/neutralization invariants remain backend/full obligations.\nif (scope !== 'frontend') {\n", '')
    .replace('\n}\n\n/**\n * Repo-wide census sweep.', '\n/**\n * Repo-wide census sweep.');
  result = result.replace('let censusSourceCount = 0;\n', '').replace('    censusSourceCount += 1;\n', '');
  result = result.replace("if (scope !== 'full' && censusSourceCount === 0) {\n  violations.push({ file: scope, added: 'empty scoped TypeScript census', pattern: 'scope input refusal' });\n}\n\nconst scopedCensus = SHARED_PLANE_CONSUMER_CENSUS.filter((entry) => contextPlaneIncludesPath(entry.file, scope));\n", '')
    .replaceAll('= scopedCensus.filter(', '= SHARED_PLANE_CONSUMER_CENSUS.filter(');
  result = result.replace("if (scope === 'full') {\nconsole.log(", 'console.log(')
    .replace("\n} else {\n  console.log(`CONTEXT_PLANE_${scope.toUpperCase()}_COMPLETE`);\n}\nconsole.log(", '\nconsole.log(');
  result = result.replace(`function sourceFilesUnder(root) {
  if (scope !== 'full') {
    try {
      return contextPlaneSourceFilesUnder(root, scope, {
        skipDirectories: CENSUS_SKIP_DIRECTORIES, testSuffixes: TEST_SUFFIXES,
      }, { readdirSync, lstatSync });
    } catch (error) {
      violations.push({ file: root, added: \`scoped source census refused: \${error.message}\`, pattern: 'scope input refusal' });
      return [];
    }
  }
`, 'function sourceFilesUnder(root) {\n');
  return result;
}

function filesystem(files, options = {}) {
  const dirs = new Map([['apps', []], ['packages', []]]);
  for (const file of Object.keys(files)) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (!dirs.has(dir)) dirs.set(dir, []);
      if (!dirs.get(dir).includes(segments[i])) dirs.get(dir).push(segments[i]);
    }
  }
  const calls = [];
  const touch = (kind, file) => {
    calls.push([kind, file]);
    if (options.denyWeb && /^(?:apps\/web|apps\/onboard-web)(?:\/|$)/.test(file)) throw new Error('DENIED_WEB');
    if (options.denyBackend && /^(?:packages|apps\/(?!web(?:\/|$)|onboard-web(?:\/|$))[^/]+)(?:\/|$)/.test(file)) throw new Error('DENIED_BACKEND');
    if (options.unreadable === file) throw new Error('UNREADABLE');
  };
  const stat = (kind, file) => {
    touch(kind, file);
    if (!dirs.has(file) && !Object.hasOwn(files, file)) throw Object.assign(new Error('missing: ' + file), { code: 'ENOENT' });
    return { isDirectory: () => dirs.has(file), isSymbolicLink: () => file === options.symlink };
  };
  return { calls,
    readdirSync: (file) => { touch('readdir', file); if (!dirs.has(file)) throw new Error('missing directory'); return dirs.get(file); },
    statSync: (file) => stat('stat', file), lstatSync: (file) => stat('lstat', file),
    readFileSync: (file) => { touch('read', file); if (!Object.hasOwn(files, file)) throw new Error('missing file'); return files[file]; },
  };
}

function run(source, args, files = seed, options = {}) {
  const fs = filesystem(files, options);
  const messages = { log: [], warn: [], error: [] };
  const gitCalls = [];
  const stopped = {};
  const fatal = new Error('inert Git failure');
  let exit = 0;
  let thrown = null;
  const context = vm.createContext({
    ...fs, readSourceFileSync: fs.readFileSync, join,
    parseContextPlaneInvocation, projectContextPlaneDiff, partitionContextPlaneDiff, assertContextPlaneReadPath,
    contextPlaneIncludesPath, contextPlaneSourceFilesUnder,
    process: { argv: ['node', 'guard.mjs', ...args], exit: (code) => { exit = code; throw stopped; }, stdout: { write: (value) => messages.log.push(value.trimEnd()) }, stderr: { write: (value) => messages.error.push(value.trimEnd()) } },
    console: Object.fromEntries(Object.keys(messages).map((key) => [key, (...values) => messages[key].push(values.join(' '))])),
    execFileSync: (command, args, settings) => {
      gitCalls.push({ command, args: [...args], settings: { ...settings } });
      if (options.gitError) throw fatal;
      return options.diff ?? '';
    },
  });
  const body = source.replace(/^#![^\n]*\n/, '').replace(/^import [\s\S]*?from ['"][^'"]+['"];\n/gm, '');
  const cli = before('scripts/cleanup-gates/lib/cli.mjs').replace(/^export /gm, '');
  try { vm.runInContext(cli + '\n' + body, context, { timeout: 3000 }); }
  catch (error) { if (error !== stopped) { exit = 1; thrown = error === fatal ? 'original Git error identity' : error.message; } }
  return { exit, thrown, messages, calls: fs.calls, gitCalls };
}

const added = (file, code) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${code}\n`;

test('complete original guard/predicates/regex/allowlist/census/operations/catches reconstruct byte-exact', () => {
  assert.equal(legacyProjection(current), original);
  for (const [needle, replacement] of [["'meri.chat'", "'meri.changed'"], ['ContextCompilerService\\b', 'OtherService\\b'], ['requireInternalContextProxy(req);\', 3', 'requireInternalContextProxy(req);\', 2'], ["status: 'unmigrated'", "status: 'neutralized'"]]) {
    const changed = current.replace(needle, replacement);
    assert.notEqual(changed, current);
    assert.notEqual(legacyProjection(changed), original);
  }
});

test('published helper custody has only unused walker removal, strict ref and attributed-count fixes', () => {
  const published = execFileSync('git', ['show', 'ed1bb4b539b297086413e7060979ea02226dc485:scripts/lib/knowledge-census-scope.mjs'], { cwd: root, encoding: 'utf8' });
  const omitted = published.slice(published.indexOf('function canTraverse('), published.indexOf('function headerPath('));
  const expected = published.replace(omitted, '').replace('      base = arg;', "      if (!/^[A-Za-z0-9._/@^~-]+$/.test(arg)) throw new Error('invalid scoped Git ref');\n      base = arg;")
    .replace(`        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
          throw new Error('ambiguous file header inside a hunk');
        }`, `        // A leading +/- belongs to content until both declared counts finish.
        // For example, added \`++ count;\` is encoded as \`+++ count;\`.
        if (hunk.old === hunk.wantOld && hunk.next === hunk.wantNext) {
          throw new Error('extra content after complete diff hunk');
        }`)
    .replace('    let metadataChange = false;', '    let metadataChange = false;\n    const additions = [];')
    .replace("        if (line.startsWith('+')) hunk.next += 1;", "        if (line.startsWith('+')) { hunk.next += 1; additions.push(line.slice(1)); }")
    .replace('    return { path, scope: knowledgeCensusPathScope(path), text };', '    return { path, scope: knowledgeCensusPathScope(path), text, additions };');
  assert.equal(readFileSync(join(root, 'scripts/lib/knowledge-census-scope.mjs'), 'utf8'), expected);
  for (const file of ['context-plane-scope.mjs', 'knowledge-census-scope.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, 'scripts/lib/' + file), 'utf8'), /from ['"]node:|\b(?:require|process|globalThis|execFileSync|readFileSync|fetch)\b/);
  }
});

test('full first/fallback/ignored-tail behavior, statuses, original Git identity and all traces remain exact', () => {
  for (const args of [[], [baseline], [baseline, 'ignored'], [baseline, '--run'], [''], [' padded-base '], ['--run'], ['bad\nref'], ['--help'], ['-h'], ['--help', baseline], ['--base', baseline]]) {
    for (const options of [{}, { gitError: true }, { diff: added('apps/web/src/new.ts', 'ContextCompilerService') }]) {
      assert.deepEqual(run(current, args, seed, options), run(original, args, seed, options));
    }
  }
});

test('explicit scopes preserve base/default but malformed requests refuse before Git or source effects', () => {
  for (const scope of ['backend', 'frontend']) for (const args of [[baseline, `--${scope}-only`], [`--${scope}-only`, baseline]]) {
    assert.deepEqual(parseContextPlaneInvocation(args), { base: baseline, scope });
  }
  for (const args of [['--backend-only', ''], [' --backend-only'], ['--FRONTEND-only'], ['--backend-only=1'], ['--scope', 'backend'], ['--backend-only', '--frontend-only'], ['--frontend-only', '--frontend-only'], ['--backend-only', 'a', 'b'], ['--backend-only', '--unknown'], ['--backend-only', 'ref;echo'], ['--frontend-only', 'x$y'], ['--backend-only', '--help']]) {
    const result = run(current, args);
    assert.equal(result.exit, 2); assert.equal(result.calls.length, 0); assert.equal(result.gitCalls.length, 0); assert.equal(result.messages.log.length, 0);
  }
});

test('backend preserves all HEAD predicates and pinned status lines with both UI trees denied/absent', () => {
  for (const files of [seed, Object.fromEntries(Object.entries(seed).filter(([file]) => !/apps\/(?:web|onboard-web)\//.test(file)))]) {
    const result = run(current, [baseline, '--backend-only'], files, { denyWeb: true });
    assert.equal(result.exit, 0, result.messages.error.join('\n'));
    assert.ok(result.messages.log.includes('CONTEXT_PLANE_BACKEND_COMPLETE'));
    assert.equal(result.calls.filter(([, file]) => /^(?:apps\/web|apps\/onboard-web)(?:\/|$)/.test(file)).length, 0);
    assert.deepEqual(result.messages.log.filter((line) => !line.startsWith('CONTEXT_PLANE_')), run(original, [baseline], seed).messages.log.slice(1));
  }
});

test('frontend proves complementary census/diff without any backend invariant reads/status claims', () => {
  const files = { 'apps/web/src/safe.ts': 'safe', 'apps/onboard-web/src/safe.tsx': 'safe' };
  const result = run(current, [baseline, '--frontend-only'], files, { denyBackend: true });
  assert.equal(result.exit, 0, result.messages.error.join('\n'));
  assert.ok(result.messages.log.includes('CONTEXT_PLANE_FRONTEND_COMPLETE'));
  assert.equal(result.messages.warn.length, 0);
  assert.equal(result.calls.filter(([, file]) => file !== 'apps' && !/^(?:apps\/web|apps\/onboard-web)(?:\/|$)/.test(file)).length, 0);
  assert.ok(!result.messages.log.some((line) => line.includes('adopted-product invariants hold')));
});

test('scope walks preserve original skip directories and suffixes, future roots and complete partition', () => {
  const files = { ...seed, 'apps/future/src/a.ts': 'safe', 'packages/future/src/a.ts': 'safe', 'apps/web/src/a.spec.ts': 'ignored', 'apps/web/src/a.spec.tsx': 'included' };
  for (const dir of policy.skipDirectories) files[`apps/web/${dir}/a.ts`] = 'ignored';
  const list = (scope, ports) => ['apps', 'packages'].flatMap((root) => contextPlaneSourceFilesUnder(root, scope, policy, ports));
  const full = list('full', filesystem(files));
  const back = list('backend', filesystem(files, { denyWeb: true }));
  const front = list('frontend', filesystem(files, { denyBackend: true }));
  assert.deepEqual([...back, ...front].sort(), full.sort());
  assert.ok(back.includes('packages/future/src/a.ts') && back.includes('apps/future/src/a.ts'));
  assert.ok(front.includes('apps/web/src/a.spec.tsx') && !front.includes('apps/web/src/a.spec.ts'));
  for (const dir of policy.skipDirectories) assert.ok(!front.includes(`apps/web/${dir}/a.ts`));
});

test('whole diff sections preserve header/hunk/target identity and no wrong-scope bans', () => {
  const back = added('packages/future/src/a.ts', 'ContextCompilerService');
  const front = added('apps/web/src/a.ts', 'ContextCompilerService');
  assert.equal(projectContextPlaneDiff(front + back, 'backend'), back);
  assert.equal(projectContextPlaneDiff(front + back, 'frontend'), front);
  for (const [scope, diff] of [['backend', front], ['frontend', back]]) {
    assert.equal(run(current, [baseline, `--${scope}-only`], seed, { diff }).exit, 0);
  }
});

test('future app/package/Web/Onboard positive diff+census failures keep original target/refusal', () => {
  for (const file of ['apps/future/src/a.ts', 'packages/future/src/a.ts', 'apps/web/src/a.ts', 'apps/onboard-web/src/a.tsx']) {
    const scope = /apps\/(?:web|onboard-web)\//.test(file) ? 'frontend' : 'backend';
    for (const options of [{ diff: added(file, 'ContextCompilerService') }, {}]) {
      const files = { ...seed, ...(options.diff ? {} : { [file]: 'ContextCompilerService' }) };
      const result = run(current, [baseline, `--${scope}-only`], files, options);
      assert.equal(result.exit, 1); assert.ok(result.messages.error.some((line) => line.includes(file)));
      assert.ok(result.messages.error.includes(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`));
      assert.ok(!result.messages.log.some((line) => line.endsWith('_COMPLETE')));
      assert.equal(run(original, [baseline], files, options).exit, 1);
    }
  }
});

test('exact adapter/census exceptions never allow changed lines, relocated symbols or stale neutralization', () => {
  const module = 'apps/api/src/workspace-assistant/workspace-assistant.module.ts';
  const approved = "import { ContextCompilerService } from '../context/context-compiler.service.js';";
  assert.equal(run(current, [baseline, '--backend-only'], seed, { diff: added(module, approved) }).exit, 0);
  for (const [file, line] of [[module, approved.replace(".js'", ".changed.js'")], ['apps/web/src/new.ts', approved]]) {
    const scope = file.startsWith('apps/web/') ? 'frontend' : 'backend';
    assert.equal(run(current, [baseline, `--${scope}-only`], seed, { diff: added(file, line) }).exit, 1);
  }
  const files = { ...seed, [module]: seed[module].replaceAll('useExisting: WorkspaceEditorContextCompilerAdapter', 'useClass: ContextCompilerService') };
  assert.equal(run(current, [baseline, '--backend-only'], files).exit, 1);
  assert.equal(run(original, [baseline], files).exit, 1);
});

test('operation, call floors, read-only tables, gateway, neutralization and governance failures remain active', () => {
  const mutations = [
    ['apps/api/src/context/context-plane-operation-registry.ts', (s) => s.replace("id: 'meri.chat'", "id: 'removed'")],
    ['apps/meriv2-orchestrator/src/meri/strategy/strategy.controller.ts', (s) => s.replaceAll('requireInternalContextProxy(req);', '')],
    ['apps/api/src/retrieval/adapters/strategy-work-retrieval.adapter.ts', (s) => s + '\nsp_send_token'],
    ['apps/api/src/engagement/generation/generation-gateway.service.ts', (s) => s.replaceAll('failClosedOnPersist: true', 'failClosedOnPersist: false')],
    ['apps/api/src/meri/meriv3-runtime.proxy.ts', (s) => s.replaceAll('governedRuntime.runChatTurn(', 'ungoverned(')],
  ];
  for (const [file, mutate] of mutations) {
    const files = { ...seed, [file]: mutate(seed[file]) };
    assert.notEqual(files[file], seed[file]);
    assert.equal(run(current, [baseline, '--backend-only'], files).exit, 1);
    assert.deepEqual(run(current, [baseline], files), run(original, [baseline], files));
  }
  assert.equal(run(current, [baseline, '--backend-only'], { ...seed, 'apps/api/src/engagement/future.ts': 'gateway.enabled' }).exit, 1);
});

test('missing/unreadable/symbolic fixed HEAD inputs fail before contents, including ancestor escapes', () => {
  const file = 'apps/api/src/context/context-plane-operation-registry.ts';
  for (const options of [{ unreadable: file }, { symlink: file }, { symlink: 'apps/api' }, { symlink: 'apps' }]) {
    const result = run(current, [baseline, '--backend-only'], seed, options);
    assert.equal(result.exit, 1);
    if (options.symlink) assert.equal(result.calls.filter(([kind, path]) => kind === 'read' && path === file).length, 0);
  }
  const files = { ...seed }; delete files[file];
  assert.equal(run(current, [baseline, '--backend-only'], files).exit, 1);
  assert.equal(run(current, [baseline, '--frontend-only'], {}, { denyBackend: true }).exit, 1);
});

test('missing/unreadable/symbolic census inputs cannot silently shrink scoped obligations', () => {
  for (const options of [{ unreadable: 'apps/web/src/safe.ts' }, { symlink: 'apps/web' }, { symlink: 'apps/web/src/safe.ts' }]) {
    const result = run(current, [baseline, '--frontend-only'], seed, options);
    assert.equal(result.exit, 1); assert.ok(result.messages.error.includes('CONTEXT_PLANE_FRONTEND_FAILED'));
  }
});

test('unavailable Git and malformed/truncated/quoted/binary sections fail before any source access', () => {
  const valid = added('apps/web/a.ts', 'ContextCompilerService');
  for (const scope of ['backend', 'frontend']) for (const options of [{ gitError: true }, { diff: '+orphan\n' }, { diff: valid.replace('+1 @@', '+1,2 @@') }, { diff: 'diff --git "a/apps/web/a.ts" "b/apps/web/a.ts"\n' }, { diff: 'diff --git a/a.ts b/a.ts\nBinary files differ\n' }]) {
    const result = run(current, [baseline, `--${scope}-only`], seed, options);
    assert.equal(result.exit, 1); assert.equal(result.calls.length, 0);
    assert.ok(result.messages.error.includes(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`));
  }
});


test('valid ++/-- hunk content preserves target identity while count/header faults refuse', () => {
  for (const file of ['apps/api/src/example.ts', 'apps/web/src/example.ts']) {
    const header = `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`;
    for (const body of ['@@ -0,0 +1 @@\n+++ count;\n', '@@ -1 +0,0 @@\n--- count;\n',
      '@@ -1 +1 @@\n--- count;\n+++ count;\n',
      '@@ -0,0 +1 @@\n+++ count;\n\\ No newline at end of file\n',
      '@@ -0,0 +1 @@\n+++ count;\n@@ -2 +3 @@\n--- count;\n+++ count;\n']) {
      const diff = header + body;
      for (const scope of ['backend', 'frontend']) {
        assert.equal(projectContextPlaneDiff(diff, scope),
          file.startsWith('apps/web/') === (scope === 'frontend') ? diff : '');
      }
    }
    for (const body of ['@@ -0,0 +1 @@\n+++ count;\n+++ b/other.ts\n',
      '@@ -1 +0,0 @@\n--- count;\n--- a/other.ts\n',
      '@@ -0,0 +1,2 @@\n+++ count;\n',
      '@@ -1 +1 @@\n+++ count;\n',
      '@@ -0,0 +1 @@\n+++ count;\n+extra\n']) {
      for (const scope of ['backend', 'frontend']) assert.throws(() => projectContextPlaneDiff(header + body, scope));
    }
    for (const scope of ['backend', 'frontend']) {
      assert.throws(() => projectContextPlaneDiff(header.replace('+++ b/' + file, '+++ b/other.ts') + '@@ -0,0 +1 @@\n+safe\n', scope));
    }
  }
});


test('scoped hunk additions stay bound to actual product path despite +++ content', () => {
  const outcomes = [];
  for (const [scope, file] of [['backend', 'apps/api/src/future/a.ts'], ['frontend', 'apps/web/src/future/a.ts']]) {
    const diff = `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,2 @@\n+++ b/apps/api/src/context/decoy.ts\n+resolveContextPacketMode();\n`;
    const selected = run(current, [baseline, '--' + scope + '-only'], seed, {diff});
    outcomes.push({scope, exit:selected.exit,
      originalPathRefusal:selected.messages.error.some((line) => line.includes(file) && line.includes('resolveContextPacketMode')),
      completion:selected.messages.log.some((line)=>line.endsWith('_COMPLETE'))});
    // Current full scanner's header-looking-content weakness is inherited.
    assert.deepEqual(run(current, [baseline], seed, {diff}), run(original, [baseline], seed, {diff}));
  }
  assert.deepEqual(outcomes, ['backend', 'frontend'].map((scope)=>({scope,exit:1,originalPathRefusal:true,completion:false})));
});
