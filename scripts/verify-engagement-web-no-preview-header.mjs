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

/**
 * Tokens no file under apps/web/src may ever contain. VITE_ENGAGEMENT_API_URL
 * and both localhost:4500 forms stay banned outright: the web must never learn
 * a second API origin, in any file, for any reason.
 */
const FORBIDDEN = ['VITE_ENGAGEMENT_API_URL', 'http://127.0.0.1:4500', 'http://localhost:4500'];

/**
 * F-002. The preview header used to be banned outright, which was correct
 * while the web had no preview mode at all — and became wrong the moment 3.3
 * implemented one, because the string the guard banned is exactly the string
 * the feature must introduce.
 *
 * Deleting the gate would have given up the property worth keeping: that the
 * routing decision lives in ONE reviewed module instead of being sprinkled
 * across feature code. So the ban is narrowed to an allowlist rather than
 * dropped. Any other file naming the header is still a hard failure.
 */
const PREVIEW_HEADER_TOKEN = 'X-Capiro-Engagement-Preview';
const PREVIEW_HEADER_ALLOWED = new Set(
  [
    'apps/web/src/lib/engagement-api-preview.ts',
  ].map((p) => path.normalize(p)),
);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && !/\.spec\.(ts|tsx|js|jsx)$/.test(entry)) yield full;
  }
}

const findings = [];
const seenAllowed = new Set();
for (const file of walk(WEB_SRC)) {
  const relative = path.relative(REPO_ROOT, file);
  const source = readFileSync(file, 'utf8');
  for (const token of FORBIDDEN) {
    if (source.includes(token)) {
      findings.push(`${relative} contains ${token}`);
    }
  }
  if (source.includes(PREVIEW_HEADER_TOKEN)) {
    if (PREVIEW_HEADER_ALLOWED.has(path.normalize(relative))) {
      seenAllowed.add(path.normalize(relative));
    } else {
      findings.push(
        `${relative} contains ${PREVIEW_HEADER_TOKEN} — only the reviewed preview module may name it`,
      );
    }
  }
}

// A stale allowlist entry is a finding too: an allowed file that no longer
// names the header means the allowlist has outlived the code it was written
// for, and would silently permit a future file at that path.
for (const allowed of PREVIEW_HEADER_ALLOWED) {
  if (!seenAllowed.has(allowed)) {
    findings.push(
      `${allowed} is allowlisted for ${PREVIEW_HEADER_TOKEN} but does not contain it — remove the stale entry`,
    );
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`FAIL  ${finding}`);
  console.error(`\nENGAGEMENT_WEB_PREVIEW_HEADER_GUARD_FAILED (${findings.length})`);
  process.exit(1);
}
console.log('ENGAGEMENT_WEB_PREVIEW_HEADER_GUARD_PASSED');
