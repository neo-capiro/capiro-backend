#!/usr/bin/env node
/**
 * Current-web no-preview-header guard.
 *
 * The dark engagement-api service is only ever reachable via
 * X-Capiro-Engagement-Preview: v3. Nothing in the production web bundle may
 * send it — that header is a routing decision the API layer never delegates
 * to the browser. This is the standalone form of the check duplicated inline
 * in several Phase 2 specs; item 10 of the required verify:engagement-phase-2
 * checks, callable on its own from CI.
 *
 * Also checks for VITE_ENGAGEMENT_API_URL and the two localhost:4500 forms,
 * mirroring assertNoWebPreviewRouting() in
 * apps/api/scripts/verify-engagement-phase1-runtime.ts.
 *
 * Usage: node scripts/verify-engagement-web-no-preview-header.mjs
 * Exit: 0 clean · 1 the current web references a forbidden token
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');

const FORBIDDEN = [
  'X-Capiro-Engagement-Preview',
  'VITE_ENGAGEMENT_API_URL',
  'http://127.0.0.1:4500',
  'http://localhost:4500',
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) yield full;
  }
}

const findings = [];
for (const file of walk(WEB_SRC)) {
  const source = readFileSync(file, 'utf8');
  for (const token of FORBIDDEN) {
    if (source.includes(token)) {
      findings.push(`${path.relative(REPO_ROOT, file)} contains ${token}`);
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`FAIL  ${finding}`);
  console.error(`\nENGAGEMENT_WEB_PREVIEW_HEADER_GUARD_FAILED (${findings.length})`);
  process.exit(1);
}
console.log('ENGAGEMENT_WEB_PREVIEW_HEADER_GUARD_PASSED');
