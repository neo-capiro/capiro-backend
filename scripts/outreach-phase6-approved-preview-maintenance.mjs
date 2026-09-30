import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolvePhase3ScopeBase } from './engagement-phase3-scope-base.mjs';

export const previewTable = 'apps/web/src/lib/engagement-api-preview-routes.generated.ts';
export const previewGenerator = 'scripts/engagement-phase3-preview-route-patterns.mjs';
export const routeManifest =
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json';
const approved = '^/api/engagement/clients/[^/]+/notetaker$';
const arrayPattern =
  /export const ENGAGEMENT_PREVIEW_ROUTE_PATTERNS: readonly string\[\] = \[\n([\s\S]*?)\n\];/;
const sha = (s) => createHash('sha256').update(s).digest('hex');

function manifestRoutes(s) {
  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed.routes) || !parsed.routes.length) throw new Error('Invalid manifest');
  return {
    ...parsed,
    routes: parsed.routes.map(({ sourceLine, ...route }) => {
      if (!Number.isInteger(sourceLine) || sourceLine < 1) throw new Error('Invalid source line');
      return route;
    }),
  };
}

// The archived Phase 6 scripts describe files/layouts superseded on main.
// Only this exact approved shared-table repair uses current retained UI
// contracts. Any Phase 6 product change retains the original verifier.
export function approvedPreviewMaintenance({ changed, before, after }) {
  if (!changed.includes(previewTable)) return false;
  if (
    changed.some(
      (p) =>
        p.startsWith('apps/web/src/pages/engagement/outreach/v3/') ||
        p === 'apps/web/src/pages/engagement/OutreachView.tsx' ||
        p === 'apps/web/src/pages/engagement/outreach/v2/index.ts' ||
        p === 'apps/web/src/lib/api-client.ts' ||
        (p.startsWith('apps/web/src/lib/engagement-api-preview') && p !== previewTable) ||
        p.startsWith('apps/api/src/outreach-v3/') ||
        p.startsWith('apps/api/src/capabilities/targets/') ||
        p.startsWith('apps/api/src/capabilities/context/') ||
        p.startsWith('docs/plans/outreach-v3/revised-phase-6'),
    )
  )
    return false;
  try {
    if (
      !isDeepStrictEqual(
        manifestRoutes(before(routeManifest)),
        manifestRoutes(after(routeManifest)),
      )
    )
      return false;
    const oldSource = before(previewTable).replace(/\r\n/g, '\n');
    const newSource = after(previewTable).replace(/\r\n/g, '\n');
    const match = oldSource.match(arrayPattern);
    if (!match) return false;
    const rows = match[1].split('\n').map((line) => {
      const row = line.match(/^  '([^']+)',$/);
      if (!row) throw new Error('Malformed generated pattern');
      return row[1];
    });
    if (rows.length !== 154 || new Set(rows).size !== rows.length || rows.includes(approved))
      return false;
    const oldHash = oldSource.match(
      /export const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =\s*'([0-9a-f]{64})'/,
    )?.[1];
    const newHash = sha(after(routeManifest));
    const knownStaleHash = '0b96735bf88116aa636d8f136296cd84c6a1237b1499094d913e43fe3c428cba';
    if (oldHash !== sha(before(routeManifest)) && oldHash !== knownStaleHash) return false;
    if (!oldSource.includes(`'${oldHash}'`) || !newSource.includes(`'${newHash}'`)) return false;
    const updated = [...rows];
    const position = rows.findIndex((p) => p.localeCompare(approved) > 0);
    updated.splice(position < 0 ? rows.length : position, 0, approved);
    let expected = oldSource.replace(match[0], () =>
      match[0].replace(match[1], () => updated.map((p) => `  '${p}',`).join('\n')),
    );
    expected = expected
      .replace(`'${oldHash}'`, `'${newHash}'`)
      .replace('ENGAGEMENT_PREVIEW_ROUTE_COUNT = 154;', 'ENGAGEMENT_PREVIEW_ROUTE_COUNT = 155;')
      .split('\n')
      .map((line) => (line.startsWith(' *   apps\\') ? line.replaceAll('\\', '/') : line))
      .join('\n');
    if (expected !== newSource) return false;
    const oldGenerator = before(previewGenerator);
    const ported = oldGenerator.replaceAll(
      'path.relative(ROOT, manifestPath)',
      "path.relative(ROOT, manifestPath).split(path.sep).join('/')",
    );
    if (after(previewGenerator) !== oldGenerator && after(previewGenerator) !== ported)
      return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveApprovedPreviewScope(root, end = 'HEAD') {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const exact = git(['rev-parse', `${end}^{commit}`]).trim();
  const base = resolvePhase3ScopeBase({ git: (args) => git(args).trim(), end: exact });
  const changed = git(['diff', '--name-only', `${base}..${exact}`])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const before = (p) => git(['show', `${base}:${p}`]);
  const after = (p) => git(['show', `${exact}:${p}`]);
  return approvedPreviewMaintenance({ changed, before, after })
    ? { base, head: exact, changed: changed.length }
    : null;
}

export function runApprovedPreviewMaintenance(root, run, end = 'HEAD') {
  const scope = resolveApprovedPreviewScope(root, end);
  if (!scope) return false;
  console.log(
    `Approved preview maintenance: ${scope.head}; Phase 6 product is unchanged from ${scope.base}.`,
  );
  run('Approved preview scope negative controls', 'node', [
    '--test',
    'scripts/outreach-phase6-approved-preview-maintenance.spec.mjs',
  ]);
  run('Preview route manifest drift', 'node', [
    'scripts/engagement-phase3-preview-route-patterns.mjs',
    '--check',
  ]);
  run('Preview header containment', 'node', [
    'scripts/verify-engagement-web-no-preview-header.mjs',
  ]);
  run('vNext decision CSS generator controls', 'node', [
    '--test',
    'scripts/port-outreach-decision-vnext-css.spec.mjs',
  ]);
  run('vNext decision CSS drift', 'node', [
    'scripts/port-outreach-decision-vnext-css.mjs',
    '--check',
  ]);
  run('Web typecheck', 'pnpm', ['--filter', '@capiro/web', 'typecheck']);
  // All retained Phase 6 tests and later current V3 tests run, including the
  // current explicit-preview/Classic, readiness, planning and no-auto-send contracts.
  run('Complete current Outreach V3 and preview contracts', 'pnpm', [
    '--filter',
    '@capiro/web',
    'exec',
    'vitest',
    'run',
    '--poolOptions.threads.singleThread',
    '--testTimeout=20000',
    '--hookTimeout=20000',
    'src/pages/engagement/outreach/v3',
    'src/lib/engagement-api-preview.spec.ts',
  ]);
  run('Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']);
  run('Current PR whitespace', 'git', ['diff', '--check', `${scope.base}..${scope.head}`]);
  console.log(`OUTREACH_V3_PHASE6_APPROVED_PREVIEW_MAINTENANCE_COMPLETE:${scope.head}`);
  return true;
}
