/**
 * Lockstep guard: `ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT` is intentionally
 * duplicated (not imported) between this CDK package and apps/api — see the
 * comment on the CDK copy in engagement-api-config.ts for why. A textual
 * read-and-compare, rather than a cross-package import, so this test has no
 * dependency on apps/api's build output or module resolution at all; it only
 * needs the source files to exist on disk.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts \
 *        test/engagement-api-promotion-token-lockstep.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT as CDK_COPY } from '../lib/engagement-api/engagement-api-config';

const APP_SOURCE = path.resolve(
  __dirname,
  '../../../apps/api/src/engagement/runtime/engagement-runtime-env.ts',
);

function extractAppCopy(): string {
  const source = readFileSync(APP_SOURCE, 'utf8');
  const match = source.match(
    /export const ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT =\s*\n?\s*'([^']+)'/,
  );
  assert.ok(
    match,
    `could not find ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT in ${APP_SOURCE} — the app-side ` +
      'export may have been renamed or reshaped without updating this lockstep test',
  );
  return match![1]!;
}

test('the CDK-side and app-side promotion acknowledgement strings are byte-identical', () => {
  const appCopy = extractAppCopy();
  assert.equal(
    CDK_COPY,
    appCopy,
    'ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT has drifted between apps/api and infra/cdk — a ' +
      'promotion config built against one will fail engagement-runtime-env.ts\'s check under ' +
      'the other. Update BOTH copies together.',
  );
});

test('the acknowledgement string is non-trivial (not empty, not a short guessable token)', () => {
  // A cheap sanity floor: this string exists specifically so a short boolean-
  // like value ("true", "yes") can never satisfy it by accident.
  assert.ok(CDK_COPY.length >= 32, `acknowledgement string is too short: ${CDK_COPY.length} chars`);
  assert.ok(!/^(true|yes|1|on)$/i.test(CDK_COPY));
});
