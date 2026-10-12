#!/usr/bin/env node
/**
 * Generate apps/e2e/routes.inventory.json from the live router sources (TSX AST).
 *
 * Run `pnpm --filter @capiro/e2e routes:inventory`. The output is committed so
 * the guard and the capture harness consume a stable, reviewable artifact; the
 * generator is re-run whenever the router sources change. There is NO
 * hand-maintained route list — discovery traverses App.tsx, VNextRouter and the
 * imported module routers, and any construct it cannot resolve becomes a
 * fail-closed obligation (never a silent omission).
 *
 *   node scripts/build-route-inventory.mjs --write
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRouteGraphAsync, REPO_ROOT } from '../lib/route-graph.mjs';
import { cleanupContractTmp } from '../lib/contract.mjs';
import { PROJECTS } from '../lib/projects.mjs';

const USAGE = 'Usage: node apps/e2e/scripts/build-route-inventory.mjs --write';
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.length !== 1 || args[0] !== '--write') {
  console.error(USAGE);
  console.error(`[routes] unknown argument: ${args.join(' ')}`);
  process.exit(2);
}

function sha(ref) {
  try {
    return execFileSync('git', ['rev-parse', ref], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const { routes, inactive, obligations } = await buildRouteGraphAsync();
cleanupContractTmp();

const captured = routes.filter((r) => r.coverage === 'captured');
const redirects = routes.filter((r) => r.coverage === 'redirect-recorded' || r.kind === 'redirect');
const mounts = routes.filter((r) => r.kind === 'module-mount');

const inventory = {
  schema: 'capiro.cleanup1.routes.inventory.v2',
  generator: 'apps/e2e/scripts/build-route-inventory.mjs',
  discovery: 'TSX AST traversal of apps/web/src/App.tsx + vnext/app/VNextRouter.tsx + imported vNext route modules (fail-closed)',
  generatedAtSource: {
    headSha: sha('HEAD'),
    treeHash: sha('HEAD^{tree}'),
    note: 'source identity is authoritative here; the baseline manifest records the separate capture-time SHA',
  },
  counts: {
    declared: routes.length,
    captured: captured.length,
    redirects: redirects.length,
    moduleMounts: mounts.length,
    inactive: inactive.length,
    obligations: obligations.length,
  },
  viewports: PROJECTS.map((p) => ({ name: p.name, ...p.viewport })),
  routes,
  inactive,
  obligations,
};

const out = path.join(REPO_ROOT, 'apps', 'e2e', 'routes.inventory.json');
writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
console.log(
  `[routes] declared=${routes.length} captured=${captured.length} redirects=${redirects.length} ` +
    `mounts=${mounts.length} inactive=${inactive.length} obligations=${obligations.length} -> ${path.relative(REPO_ROOT, out)}`,
);
if (obligations.length) {
  console.error('[routes] FAIL-CLOSED obligations present:');
  for (const o of obligations) console.error(`  ! ${o.source} :: ${o.reason}`);
  process.exitCode = 2;
}
