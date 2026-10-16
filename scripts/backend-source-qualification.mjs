#!/usr/bin/env node
/** Explicit finite current-backend source catalog. It does not run services. */
import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Deliberately small shell-free command grammar for the default Turbo tasks. */
export function commandTokens(command) {
  if (typeof command !== 'string' || !command.trim() || /[;&|<>`$%#\r\n\\]/.test(command)) {
    throw new Error('shell control, substitution, escape or empty command is forbidden');
  }
  const tokens = [];
  let token = '', quote = null, started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else { token += char; started = true; }
  }
  if (quote) throw new Error('unterminated command quote');
  if (started) tokens.push(token);
  return tokens;
}

function turboDefault(scripts, name, task, seen = new Set()) {
  if (seen.has(name)) throw new Error(`script delegation cycle at ${name}`);
  seen.add(name);
  const tokens = commandTokens(scripts[name]);
  if (tokens[0] === 'pnpm') {
    const alias = tokens[1] === 'run' && tokens.length === 3 ? tokens[2] : tokens.length === 2 ? tokens[1] : null;
    if (!alias || !Object.hasOwn(scripts, alias)) throw new Error('default script must delegate to an existing single pnpm script');
    return turboDefault(scripts, alias, task, seen);
  }
  if (tokens[0] !== 'turbo' || tokens[1] !== 'run' || tokens[2] !== task) {
    throw new Error(`default must execute turbo run ${task}`);
  }
  const filters = [];
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--') throw new Error('argument forwarding cannot stand in for Turbo filters');
    if (/^--(?:cwd|root|directory)(?:=|$)/.test(token)) throw new Error('default Turbo task cannot redirect workspace ownership');
    if (token === '--filter') {
      const value = tokens[++index];
      if (!value || value.startsWith('--')) throw new Error('filter requires a real value');
      filters.push(value);
    } else if (token.startsWith('--filter=')) {
      const value = token.slice('--filter='.length);
      if (!value) throw new Error('filter requires a real value');
      filters.push(value);
    } else if (['--force', '--no-cache'].includes(token)) {
      // These options preserve actual task execution and task ownership.
    } else {
      const equals = token.indexOf('=');
      const option = equals < 0 ? token : token.slice(0, equals);
      const allowed = {
        '--concurrency': /^[1-9]\d*$/,
        '--output-logs': /^(full|hash-only|new-only|errors-only|none)$/,
        '--log-order': /^(auto|stream|grouped)$/,
        '--ui': /^(tui|stream)$/,
      }[option];
      if (!allowed) throw new Error(`unowned or non-executing Turbo option ${token}`);
      const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
      if (!allowed.test(value ?? '')) throw new Error(`invalid value for ${option}`);
    }
  }
  for (const name of ['!@capiro/onboard-web', '!@capiro/e2e']) {
    if (!filters.includes(name)) throw new Error(`missing actual Turbo filter ${name}`);
  }
  if (filters.length !== 2 || new Set(filters).size !== 2 ||
      filters.some(value => !['!@capiro/onboard-web', '!@capiro/e2e'].includes(value))) {
    throw new Error('default Turbo task requires exactly the two reviewed exclusion filters; extra or duplicated selectors require owner review');
  }
  return { task, delegatedThrough: [...seen], filters };
}

function workspaceGlobs(text) {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex(row => row.trim() === 'packages:');
  if (start < 0) throw new Error('workspace packages list is missing');
  const globs = [];
  for (const row of rows.slice(start + 1)) {
    if (!row.trim() || /^\s*#/.test(row)) continue;
    if (!/^\s/.test(row)) break;
    const match = /^\s+-\s+(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(row);
    if (!match || (match[3]?.startsWith('!'))) throw new Error('workspace glob must be a plain YAML string');
    globs.push(match[1] ?? match[2] ?? match[3]);
  }
  return globs;
}

function lockImporters(text) {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex(row => row === 'importers:');
  if (start < 0) throw new Error('lock importers section is missing');
  const importers = [];
  for (const row of rows.slice(start + 1)) {
    if (row && !/^\s|^#/.test(row)) break;
    const match = /^  (?:'([^']+)'|"([^"]+)"|([^ :]+)):\s*$/.exec(row);
    if (match) importers.push(match[1] ?? match[2] ?? match[3]);
  }
  return importers;
}
function includedBy(globs, relative) {
  const match = glob => new RegExp('^' + glob.split('/').map(part => part === '**' ? '.*' :
    part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')).join('/') + '$').test(relative);
  return globs.some(glob => !glob.startsWith('!') && match(glob)) &&
    !globs.some(glob => glob.startsWith('!') && match(glob.slice(1)));
}

export function readCurrentWorkspaceInputs(root = ROOT) {
  const present = relative => {
    try { lstatSync(path.join(root, relative)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return {
    manifest: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
    workspace: readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    lock: readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
    presence: Object.fromEntries(['apps/web/package.json', 'apps/web/src',
      'apps/onboard-web/package.json', 'apps/e2e/package.json', 'apps/e2e/lib/source-identity.mjs']
      .map(relative => [relative, present(relative)])),
  };
}
/** Current ownership fields only: unrelated deps, versions and backend importers may evolve. */
export function validateCurrentWorkspaceInputs({ manifest, workspace, lock, presence }) {
  const issues = [];
  let globs = [], importers = [];
  try { globs = workspaceGlobs(workspace); } catch (error) { issues.push(error.message); }
  try { importers = lockImporters(lock); } catch (error) { issues.push(error.message); }
  for (const relative of ['apps/web/package.json', 'apps/web/src']) {
    if (presence[relative]) issues.push(`retired Web source/workspace returned: ${relative}`);
  }
  if (!globs.includes('!apps/web')) issues.push('workspace must explicitly exclude !apps/web');
  if (importers.includes('apps/web')) issues.push('retired Web lock importer returned');
  for (const name of ['onboard-web', 'e2e']) {
    const relative = `apps/${name}`;
    if (!presence[`${relative}/package.json`] || !includedBy(globs, relative) || !importers.includes(relative)) {
      issues.push(`retained ${name} support lost its package/workspace/importer owner`);
    }
  }
  if (!presence['apps/e2e/lib/source-identity.mjs']) issues.push('retained E2E source-identity support is missing');
  const tasks = {};
  for (const task of ['build', 'dev', 'lint', 'test', 'typecheck']) {
    try { tasks[task] = turboDefault(manifest.scripts ?? {}, task, task); }
    catch (error) { issues.push(`default ${task} ownership: ${error.message}`); }
  }
  return { issues, tasks, scope: 'current-workspace-ownership-fields-only' };
}
export function backendSourceMode(argv) {
  if (argv.length !== 1 || !['--plan', '--run', '--check-workspace', '--help'].includes(argv[0])) {
    throw new Error('Use exactly --plan, --run, --check-workspace or --help');
  }
  return argv[0];
}
export function backendSourcePlan() {
  return {
    scope: 'current-backend-source-contracts-only', frontendParityOwner: 'capiro-frontend',
    currentWorkspaceContract: { execution: 'in-process before child steps',
      validator: 'validateCurrentWorkspaceInputs', scope: 'current workspace/source/importer/default-task ownership fields; no whole-file hash' },
    current: [
      ['Owned qualification input identity', ['--test', '--test-isolation=none', 'tests/support/legacy-web/inputs.spec.mjs']],
      ['Current backend contract controls', ['--test', '--test-isolation=none', 'scripts/engagement-phase3-backend-contract.spec.mjs']],
      ['Current source catalog controls', ['--test', '--test-isolation=none', 'scripts/backend-source-qualification.spec.mjs']],
      ['Current backend route declarations', ['scripts/engagement-phase3-backend-contract.mjs', '--check-routes']],
      ['Current backend preview boundary', ['scripts/engagement-phase3-backend-contract.mjs', '--check-preview-boundary']],
      ['Current canonical runtime ownership controls', ['--test', '--test-isolation=none',
        'scripts/lib/defense-runtime-source-ownership.test.mjs', 'scripts/lib/phase17-operator-ownership.test.mjs']],
      ['Canonical runtime source ownership', ['scripts/verify-defense-budget-mirror-parity.mjs']],
      ['Canonical session4 source ownership', ['scripts/verify-phase8-session4.mjs']],
      ['Current Directory mapper contracts', ['--test', '--test-isolation=none', 'scripts/ci/directory-detail-mappers.contract.spec.mjs']],
      ['Current Meri domain and Engagement cleanup contracts', ['--test', '--test-isolation=none', 'scripts/ci/meri-domain-cleanup.contract.spec.mjs']],
    ],
    historical: [
      { path: 'scripts/engagement-phase3-ui-inventory.spec.mjs', cases: 32,
        owner: 'capiro-frontend', requiredInput: 'CAPIRO_LEGACY_WEB_SOURCE_ROOT at sealed source4e' },
      { path: 'scripts/engagement-phase3-preview-route-patterns.mjs', owner: 'capiro-frontend',
        scope: 'historical-browser-table-generation', inheritedPrefixFailures: 5 },
      { path: 'scripts/cleanup-script-smoke/web-visual-cli-controls.mjs', scenarios: 27, assertions: 144,
        owner: 'capiro-frontend', requiredArgument: '--historical-replay', inheritedPackageFailures: 2 },
      { path: 'tests/support/legacy-web/historical-source-replay.spec.mjs', cases: 3,
        owner: 'capiro-frontend', requiredInput: 'CAPIRO_LEGACY_WEB_SOURCE_ROOT at sealed source4e' },
    ],
    acceptanceLimits: ['no current frontend parity', 'no compiler/build/native/database/browser execution',
      'no live router/service/deployment attestation', 'no preview header authority or browser-table write'],
    executionNotes: ['The two canonical runtime source verifiers perform finite synchronous Git reads; they start no child services or compiler.',
      'Source qualification uses the Node24 runner and builtin TypeScript stripping in existing fixture controls. This implies no upgrade of the retained Onboard Node20 image/runtime.'],
    unrunScopes: [
      { scope: 'nativeApplication', status: 'UNRUN', owner: 'backend application owners/shared local queue' },
      { scope: 'install', status: 'UNRUN', owner: 'backend integration owner/shared local queue' },
      { scope: 'build', status: 'UNRUN', owner: 'backend integration owner/shared local queue' },
      { scope: 'image', status: 'UNRUN', owner: 'backend integration owner/shared local queue' },
      { scope: 'frontend', status: 'UNRUN', owner: 'capiro-frontend' },
      { scope: 'Onboard-default-source-SPA-and-Node20-image', status: 'UNRUN',
        owner: 'backend Onboard/API image owner/shared local queue',
        obligation: 'Current default still builds/serves retained Onboard source dependencies; workspace checks establish retention only, not image acceptance.' },
      { scope: 'Onboard-optional-artifact-image', status: 'UNRUN', owner: 'backend Onboard artifact/image owner/shared local queue',
        obligation: 'Retained optional artifact admission remains separate; old whole-lock transition profiles are historical evidence.' },
      { scope: 'native-platform', status: 'UNRUN', owner: 'Windows/native qualification owner/shared local queue' },
    ],
  };
}
export function executeBackendSourcePlan(execute, plan = backendSourcePlan()) {
  if (!Array.isArray(plan?.current) || plan.current.length === 0 ||
      JSON.stringify(plan.current) !== JSON.stringify(backendSourcePlan().current)) {
    throw new Error('Current source plan is empty, incomplete or outside fixed argv ownership');
  }
  const workspace = validateCurrentWorkspaceInputs(readCurrentWorkspaceInputs());
  if (workspace.issues.length) throw new Error(`Current workspace ownership failed: ${workspace.issues.join('; ')}`);
  const completed = ['Current workspace ownership'];
  for (const [label, args] of plan.current) {
    const result = execute(process.execPath, ['--max-old-space-size=128', ...args],
      { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 120_000 });
    if (!result || result.status !== 0 || result.error || result.signal) {
      throw new Error(`${label} failed${result?.status == null ? '' : ` with exit ${result.status}`}`);
    }
    completed.push(label);
  }
  return completed;
}
export function runBackendSourceQualification(argv, { execute = spawnSync, output = console.log } = {}) {
  const mode = backendSourceMode(argv);
  if (mode === '--help') {
    output('Use --plan to inspect current backend ownership, --check-workspace for current workspace fields, or --run for this finite source-only catalog. Canonical frontend parity owner: capiro-frontend. Historical cases require explicit replay inputs.');
    return;
  }
  if (mode === '--plan') { output(JSON.stringify(backendSourcePlan(), null, 2)); return; }
  if (mode === '--check-workspace') {
    const result = validateCurrentWorkspaceInputs(readCurrentWorkspaceInputs());
    if (result.issues.length) throw new Error(`Current workspace ownership failed: ${result.issues.join('; ')}`);
    output('CURRENT_BACKEND_WORKSPACE_OWNERSHIP_OK ' + JSON.stringify(result));
    return;
  }
  const completed = executeBackendSourcePlan(execute);
  output('CURRENT_BACKEND_SOURCE_QUALIFICATION_COMPLETE ' + JSON.stringify({ completed,
    scope: backendSourcePlan().scope, frontendParityOwner: 'capiro-frontend' }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { backendSourceMode(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(2); }
  try { runBackendSourceQualification(process.argv.slice(2)); }
  catch (error) { console.error(`CURRENT_BACKEND_SOURCE_QUALIFICATION_FAILED: ${error.message}`); process.exit(1); }
}
