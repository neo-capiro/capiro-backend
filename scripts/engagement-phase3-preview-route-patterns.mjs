#!/usr/bin/env node
/**
 * Phase 3 micro-session 3.3 — preview route-pattern generator and drift gate.
 *
 * The preview activation contract requires EXACT route-manifest matching, not
 * substring matching: a `startsWith('/api/engagement')` test would happily send
 * the header to `/api/engagement-something-else` (a path the ALB preview rule
 * does not cover) and, worse, would keep passing after someone renames a real
 * route out from under it. So the web matches a closed list of patterns derived
 * from the accepted Phase 0 route manifest.
 *
 * Importing the manifest itself into apps/web is the obvious alternative and is
 * rejected on purpose: it ships a 110-route, ~40KB JSON blob describing
 * controllers, guards, DTOs and source line numbers into the production bundle
 * for a feature that is off by default. This script emits only what the browser
 * needs — the path patterns — and then FAILS when that list diverges from the
 * manifest, which is the same friction 3.1 established for the consumer
 * inventory.
 *
 * Two manifest paths are deliberately excluded; see EXCLUSIONS below. The
 * exclusion list is part of the generated output so the omission is visible in
 * the diff rather than implied by a count.
 *
 * Usage:
 *   node scripts/engagement-phase3-preview-route-patterns.mjs --check
 *   node scripts/engagement-phase3-preview-route-patterns.mjs --write
 *
 * Exit: 0 the generated module matches the manifest · 1 it has drifted
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROUTE_MANIFEST_PATH = path.join(
  ROOT,
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
);
const GENERATED_PATH = path.join(
  ROOT,
  'apps/web/src/lib/engagement-api-preview-routes.generated.ts',
);

/** Only paths under this prefix are reachable through the ALB preview rule. */
export const PREVIEW_PREFIX = '/api/engagement';

/**
 * Manifest paths intentionally NOT given a preview pattern, each with the
 * reason. A manifest path that is neither patterned nor listed here is a hard
 * failure — silence is the failure mode this table exists to prevent.
 *
 * Both entries are outside `/api/engagement/*`, which is the ALB preview rule's
 * path condition. Sending the header to them could not route anywhere new; it
 * would only leak an internal routing decision to services that never asked for
 * one.
 */
export const EXCLUSIONS = [
  {
    path: '/api/internal/ai-credentials/resolve',
    reason:
      'Service-to-service credential resolve. Not called from the browser (no web consumer in the 3.1 inventory) and outside the ALB preview rule path condition. Phase 4 owns this boundary.',
  },
  {
    path: '/webhooks/recall',
    reason:
      'Recall.ai inbound webhook. Called by Recall, never by the SPA, and Phase 3 explicitly does not move callback traffic.',
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

export function renderModule(manifest, manifestSha256, built) {
  const patternLines = built.patterns.map((pattern) => `  '${pattern}',`).join('\n');
  const exclusionLines = EXCLUSIONS.map(
    (entry) => ` *   ${entry.path}\n *     ${entry.reason}`,
  ).join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json
 * Generator: scripts/engagement-phase3-preview-route-patterns.mjs
 * Regenerate: node scripts/engagement-phase3-preview-route-patterns.mjs --write
 *
 * Anchored path patterns for every accepted Engagement route the browser may
 * send the Engagement API preview header to. (The header name itself lives in
 * engagement-api-preview.ts — the one module allowed to spell it.) Anchored on
 * purpose: substring matching would send the header to look-alike paths the ALB
 * preview rule does not cover, and would not notice a renamed route.
 *
 * Deliberately excluded manifest paths:
${exclusionLines}
 */

/** sha256 of the route manifest these patterns were generated from. */
export const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =
  '${manifestSha256}';

/** Manifest schema version these patterns were generated from. */
export const ENGAGEMENT_ROUTE_MANIFEST_SCHEMA_VERSION = ${manifest.schemaVersion};

/** Distinct manifest paths covered by the patterns below. */
export const ENGAGEMENT_PREVIEW_ROUTE_COUNT = ${built.patterns.length};

export const ENGAGEMENT_PREVIEW_ROUTE_PATTERNS: readonly string[] = [
${patternLines}
];
`;
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const raw = readFileSync(ROUTE_MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);
  const manifestSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');

  const built = buildPatterns(manifest);

  const problems = [];
  for (const routePath of built.unaccounted) {
    problems.push(
      `manifest path ${routePath} is outside ${PREVIEW_PREFIX}/ and is not in the reviewed EXCLUSIONS table`,
    );
  }
  for (const routePath of built.staleExclusions) {
    problems.push(`EXCLUSIONS names ${routePath}, which is no longer in the route manifest`);
  }
  if (built.patterns.length === 0) {
    problems.push('no preview route patterns were derived from the manifest');
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    console.error(`\nENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (${problems.length})`);
    process.exit(1);
  }

  const rendered = renderModule(manifest, manifestSha256, built);

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
      `FAIL  ${path.relative(ROOT, GENERATED_PATH)} has drifted from the route manifest`,
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
