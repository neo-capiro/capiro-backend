#!/usr/bin/env node
/**
 * Engagement API preview route-pattern generator and drift gate.
 *
 * The browser must attach the preview header only to exact routes owned by the
 * engagement-api runtime. The original Phase 3 manifest remains the primary
 * parity manifest; additive Outreach V3 state, reasoning, target, and context
 * manifests are merged here so the final V3 customer UI can reach the dark
 * runtime without widening the header to an unsafe prefix match.
 *
 * Usage:
 *   node scripts/engagement-phase3-preview-route-patterns.mjs --check
 *   node scripts/engagement-phase3-preview-route-patterns.mjs --write
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRIMARY_ROUTE_MANIFEST_PATH = path.join(
  ROOT,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);
const ADDITIVE_ROUTE_MANIFEST_PATHS = [
  path.join(ROOT, 'apps/api/src/outreach-v3/__fixtures__/outreach-v3-route-manifest.v1.json'),
  path.join(
    ROOT,
    'apps/api/src/outreach-v3/__fixtures__/outreach-v3-reasoning-route-manifest.v1.json',
  ),
  path.join(
    ROOT,
    'apps/api/src/outreach-v3/__fixtures__/outreach-v3-target-route-manifest.v1.json',
  ),
  path.join(
    ROOT,
    'apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json',
  ),
];
const GENERATED_PATH = path.join(
  ROOT,
  'apps/web/src/lib/engagement-api-preview-routes.generated.ts',
);

/** Only paths under this prefix are reachable through the ALB preview rule. */
export const PREVIEW_PREFIX = '/api/engagement';

/**
 * Primary-manifest paths deliberately excluded from browser preview routing.
 * Additive Outreach V3 manifests are required to contain only engagement-api
 * browser routes and therefore do not have a separate exclusion table.
 */
export const EXCLUSIONS = [
  {
    path: '/api/internal/ai-credentials/resolve',
    reason:
      'Service-to-service credential resolve. Not called from the browser and outside the ALB preview rule path condition.',
  },
  {
    path: '/webhooks/recall',
    reason:
      'Recall.ai inbound webhook. Called by Recall, never by the SPA, and not owned by preview routing.',
  },
];

/** Convert one manifest path into an anchored regex source string. */
export function pathToPattern(routePath) {
  const segments = routePath.split('/').map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return `^${segments.join('/')}$`;
}

export function buildPatterns(manifest) {
  const distinct = [...new Set(manifest.routes.map((route) => route.path))].sort();
  const excluded = new Set(EXCLUSIONS.map((entry) => entry.path));

  const unaccounted = distinct.filter(
    (routePath) => !routePath.startsWith(`${PREVIEW_PREFIX}/`) && !excluded.has(routePath),
  );
  const staleExclusions = [...excluded].filter((routePath) => !distinct.includes(routePath));

  return {
    patterns: distinct
      .filter((routePath) => routePath.startsWith(`${PREVIEW_PREFIX}/`))
      .map(pathToPattern),
    coveredPaths: distinct.filter((routePath) => routePath.startsWith(`${PREVIEW_PREFIX}/`)),
    unaccounted,
    staleExclusions,
  };
}

export function renderModule(primaryManifest, primaryManifestSha256, built) {
  const patternLines = built.patterns.map((pattern) => `  '${pattern}',`).join('\n');
  const exclusionLines = EXCLUSIONS.map(
    (entry) => ` *   ${entry.path}\n *     ${entry.reason}`,
  ).join('\n');
  const additiveSources = ADDITIVE_ROUTE_MANIFEST_PATHS.map(
    (manifestPath) => ` *   ${path.relative(ROOT, manifestPath)}`,
  ).join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Primary source:
 *   apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json
 * Additive Outreach V3 sources:
${additiveSources}
 * Generator: scripts/engagement-phase3-preview-route-patterns.mjs
 * Regenerate: node scripts/engagement-phase3-preview-route-patterns.mjs --write
 *
 * Anchored path patterns for every accepted browser route owned by the
 * engagement-api runtime. The preview header name remains isolated in
 * engagement-api-preview.ts. Prefix or substring matching is prohibited.
 *
 * Deliberately excluded primary-manifest paths:
${exclusionLines}
 */

/** sha256 of the primary Engagement parity manifest. */
export const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =
  '${primaryManifestSha256}';

/** Primary manifest schema version. */
export const ENGAGEMENT_ROUTE_MANIFEST_SCHEMA_VERSION = ${primaryManifest.schemaVersion};

/** Distinct primary + additive manifest paths covered below. */
export const ENGAGEMENT_PREVIEW_ROUTE_COUNT = ${built.patterns.length};

export const ENGAGEMENT_PREVIEW_ROUTE_PATTERNS: readonly string[] = [
${patternLines}
];
`;
}

function readManifest(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8');
  return { raw, manifest: JSON.parse(raw) };
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const primary = readManifest(PRIMARY_ROUTE_MANIFEST_PATH);
  const additive = ADDITIVE_ROUTE_MANIFEST_PATHS.map(readManifest);
  const primaryManifestSha256 = createHash('sha256')
    .update(primary.raw, 'utf8')
    .digest('hex');

  const combinedManifest = {
    ...primary.manifest,
    routes: [
      ...primary.manifest.routes,
      ...additive.flatMap((entry) => entry.manifest.routes),
    ],
  };
  const built = buildPatterns(combinedManifest);

  const problems = [];
  for (const routePath of built.unaccounted) {
    problems.push(
      `manifest path ${routePath} is outside ${PREVIEW_PREFIX}/ and is not in the reviewed EXCLUSIONS table`,
    );
  }
  for (const routePath of built.staleExclusions) {
    problems.push(`EXCLUSIONS names ${routePath}, which is no longer in the route manifests`);
  }
  if (built.patterns.length === 0) problems.push('no preview route patterns were derived');

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    console.error(`\nENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (${problems.length})`);
    process.exit(1);
  }

  const rendered = renderModule(primary.manifest, primaryManifestSha256, built);

  if (mode === 'write') {
    writeFileSync(GENERATED_PATH, rendered, 'utf8');
    console.log(
      `wrote ${path.relative(ROOT, GENERATED_PATH)} (${built.patterns.length} patterns, ${EXCLUSIONS.length} excluded)`,
    );
    return;
  }

  let current;
  try {
    current = readFileSync(GENERATED_PATH, 'utf8');
  } catch {
    console.error(`FAIL  ${path.relative(ROOT, GENERATED_PATH)} does not exist`);
    console.error('\nENGAGEMENT_PREVIEW_ROUTE_PATTERNS_DRIFTED');
    process.exit(1);
  }

  if (current !== rendered) {
    console.error(
      `FAIL  ${path.relative(ROOT, GENERATED_PATH)} has drifted from the route manifests`,
    );
    console.error('      run: node scripts/engagement-phase3-preview-route-patterns.mjs --write');
    console.error('\nENGAGEMENT_PREVIEW_ROUTE_PATTERNS_DRIFTED');
    process.exit(1);
  }

  console.log(
    `ENGAGEMENT_PREVIEW_ROUTE_PATTERNS_CURRENT (${built.patterns.length} patterns, ${EXCLUSIONS.length} excluded)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
