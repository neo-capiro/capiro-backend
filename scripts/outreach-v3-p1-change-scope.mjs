#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productDirectories = [
  'engagement',
  'engagement-workers',
  'engagement-callbacks',
  'webhooks',
  'capabilities',
  'ai-credentials',
  'intelligence/alert-memo',
  'client-documents',
  'meeting-capture',
  'outreach-review',
  'reviews',
].map((part) => `apps/api/src/${part}/`);
const productFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'apps/api/package.json',
  'apps/api/tsconfig.outreach-v3-phase1.json',
  'apps/api/src/engagement-api.app.module.ts',
  'apps/api/src/engagement-api.app.module.spec.ts',
  'apps/api/src/meri/meri.module.ts',
  'apps/api/src/app.module.ts',
  'infra/cdk/fixtures/engagement-runtime-ownership.v1.json',
  'docs/contracts/capiro-capabilities-v1.md',
  'docs/contracts/engagement-runtime-ownership-v1.md',
  'docs/runbooks/capiro-capability-security.md',
  'docs/runbooks/engagement-runtime-ownership.md',
]);
const routeFixture = 'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json';
const persistenceService = 'apps/api/src/meeting-capture/meeting-capture-persistence.service.ts';
const tsconfig = 'apps/api/tsconfig.outreach-v3-phase1.json';

function ownedProduct(file) {
  return (
    productFiles.has(file) ||
    productDirectories.some((prefix) => file.startsWith(prefix)) ||
    /^docs\/plans\/outreach-v3\/revised-phase-[12]-/.test(file)
  );
}
function ownedGate(file) {
  return (
    file === '.github/workflows/outreach-v3-p1-preflight.yml' ||
    file === 'scripts/verify-engagement-phase3-code.mjs' ||
    /^scripts\/[^/]*(outreach-v3-p1|outreach-v3-phase1|engagement-runtime-ownership)/.test(file)
  );
}
function onlyRouteSourceLines(before, after) {
  const strip = (text) => {
    const fixture = JSON.parse(text);
    if (!Array.isArray(fixture.routes) || fixture.routes.length === 0)
      throw new Error('Invalid route fixture');
    return {
      ...fixture,
      routes: fixture.routes.map(({ sourceLine, ...route }) => {
        if (!Number.isInteger(sourceLine) || sourceLine < 1) throw new Error('Invalid source line');
        return route;
      }),
    };
  };
  return isDeepStrictEqual(strip(before), strip(after));
}
function onlyDeclarationInclude(before, after) {
  const previous = JSON.parse(before);
  const current = JSON.parse(after);
  const declaration = 'src/types/word-extractor.d.ts';
  if (
    !Array.isArray(previous.include) ||
    previous.include.includes(declaration) ||
    !Array.isArray(current.include)
  )
    return false;
  return isDeepStrictEqual(
    { ...previous, include: [...previous.include, declaration].sort() },
    { ...current, include: [...current.include].sort() },
  );
}

// Maintenance still runs every invariant and named test. Runtime/contract
// changes retain whole-PR attribution, including forbidden UI/migration paths.
export function classifyChange(file, before, after) {
  if (ownedGate(file)) return 'gate';
  if (!ownedProduct(file)) return 'unowned';
  if (after == null) return 'product';
  if (/\.spec\.ts$/.test(file)) return 'gate';
  if (before == null) return 'product';
  try {
    if (file === routeFixture && onlyRouteSourceLines(before, after)) return 'gate';
    if (file === tsconfig && onlyDeclarationInclude(before, after)) return 'gate';
    if (
      file === persistenceService &&
      before.replace(
        'receives this six-method object rather than the broad EngagementService.',
        'receives this seven-method object rather than the broad EngagementService.',
      ) === after
    )
      return 'gate';
  } catch {
    // Malformed maintenance input must retain product attribution.
  }
  return 'product';
}

export function inspectChanges(changes) {
  const classified = changes.map(({ file, before, after }) => ({
    file,
    category: classifyChange(file, before, after),
  }));
  return {
    shouldRun: classified.some(({ category }) => category !== 'unowned'),
    productChanged: classified.some(({ category }) => category === 'product'),
    classified,
  };
}

function main() {
  const base = process.argv[process.argv.indexOf('--base') + 1];
  if (!process.argv.includes('--base') || !base) throw new Error('A verified PR base is required');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const names = git(['diff', '--name-only', '-z', `${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
  const read = (revision, file) => {
    try {
      return execFileSync('git', ['show', `${revision}:${file}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  const result = inspectChanges(
    names.map((file) => ({ file, before: read(mergeBase, file), after: read('HEAD', file) })),
  );
  console.log(`should_run=${result.shouldRun}`);
  console.log(`product_changed=${result.productChanged}`);
  console.log(`scope_base=${result.productChanged ? base : git(['rev-parse', 'HEAD']).trim()}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
