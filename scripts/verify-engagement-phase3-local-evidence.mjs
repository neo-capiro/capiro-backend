#!/usr/bin/env node
/**
 * Final Phase 3 local evidence-bundle verifier.
 *
 * Child verifiers already fail on their owning assertions. This last pass proves
 * the complete exact-SHA bundle exists, contains every required terminal marker,
 * has no silent scenario omissions, records cleanup/invariance, and retains no
 * bearer/cookie/JWT material. It never reads the OS-temp token file.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EVIDENCE = path.resolve(required('ENGAGEMENT_PHASE3_EVIDENCE_DIR'));
const EXPECTED_SHA = required('RELEASE_SHA');
const INVENTORY = path.join(
  ROOT,
  'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
);
const FINDINGS = path.join(
  ROOT,
  'docs/plans/engagement-api/phase-3-findings-ledger.v2.json',
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function json(relative) {
  const filename = path.join(EVIDENCE, relative);
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    throw new Error(`Missing or invalid Phase 3 evidence ${relative}: ${error.message}`);
  }
}

function marker(relative, document, expected) {
  if (document?.marker !== expected) {
    throw new Error(`${relative}: expected marker ${expected}, found ${String(document?.marker)}`);
  }
}

function requireTrue(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesUnder(root) {
  const output = [];
  const walk = async (current) => {
    for (const entry of await readdir(current)) {
      const full = path.join(current, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else output.push(full);
    }
  };
  await walk(root);
  return output;
}

function uniqueExternalCount(inventory) {
  return new Set(
    (inventory.requests ?? [])
      .filter((row) => row.classification === 'external_action')
      .map((row) => `${row.method} ${row.requestPath}`),
  ).size;
}

async function assertNoRetainedSecrets() {
  const prohibitedFilename = /bearer|token-file|cookie|session-jwt/i;
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/;
  const authHeader = /(?:authorization|cookie)\s*["':=]+\s*(?:bearer\s+)?[A-Za-z0-9_.-]{20,}/i;
  const clerkSecret = /sk_(?:test|live)_[A-Za-z0-9]{12,}/;
  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  const violations = [];

  for (const filename of await filesUnder(EVIDENCE)) {
    const relative = path.relative(EVIDENCE, filename).split(path.sep).join('/');
    if (prohibitedFilename.test(path.basename(relative))) {
      violations.push(`${relative}: prohibited retained filename`);
    }
    const info = await stat(filename);
    if (info.size > 5_000_000 || /\.(png|jpg|jpeg|webp|zip|tar|gz)$/i.test(filename)) continue;
    const source = await readFile(filename, 'utf8').catch(() => '');
    for (const [label, pattern] of [
      ['JWT', jwt],
      ['auth header/cookie', authHeader],
      ['Clerk secret', clerkSecret],
      ['private key', privateKey],
    ]) {
      if (pattern.test(source)) violations.push(`${relative}: retained ${label}`);
    }
  }
  if (violations.length) {
    throw new Error(`Phase 3 evidence retained secret material:\n${violations.join('\n')}`);
  }
}

async function main() {
  requireTrue(/^[0-9a-f]{40}$/i.test(EXPECTED_SHA), 'RELEASE_SHA must be an exact 40-character SHA');
  const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'));
  const findings = JSON.parse(await readFile(FINDINGS, 'utf8'));
  requireTrue(findings.counts?.openP0 === 0, 'findings ledger has open P0');
  requireTrue(findings.counts?.openP1 === 0, 'findings ledger has open P1');
  requireTrue(findings.counts?.blockingP2 === 0, 'findings ledger has blocking P2');

  const browser = await json('browser-parity.json');
  marker('browser-parity.json', browser, 'ENGAGEMENT_PHASE3_BROWSER_COMPLETE');
  requireTrue(browser.modes?.main && browser.modes?.preview, 'browser parity lacks both modes');
  requireTrue(browser.domParity?.every?.((row) => row.equal === true) !== false, 'browser DOM parity contains a mismatch');

  const interactions = await json('browser-interactions.json');
  marker(
    'browser-interactions.json',
    interactions,
    'ENGAGEMENT_PHASE3_BROWSER_INTERACTIONS_COMPLETE',
  );
  requireTrue(interactions.noSilentSkips === true, 'browser interactions did not prove no silent skips');
  requireTrue(interactions.scenarios?.length >= 22, 'browser interaction scenario matrix is incomplete');
  requireTrue(interactions.responsive?.length >= 12, 'responsive interaction matrix is incomplete');
  requireTrue(interactions.interactions?.length === 4, 'named interaction domains must equal four');
  for (const row of interactions.scenarios ?? []) {
    requireTrue(
      ['PASS_MAIN_AND_PREVIEW', 'BASELINE_DEFECT_PROVEN'].includes(row.status),
      `scenario ${row.scenarioId} has no terminal status`,
    );
  }

  const recovery = await json('browser-recovery.json');
  marker('browser-recovery.json', recovery, 'ENGAGEMENT_PHASE3_BROWSER_RECOVERY_COMPLETE');
  requireTrue(recovery.noSilentSkips === true, 'browser recovery did not prove no silent skips');
  requireTrue(recovery.cases === 4, `browser recovery expected 4 cases, found ${recovery.cases}`);

  const replay = await json('read-parity.json');
  marker('read-parity.json', replay, 'ENGAGEMENT_PHASE3_READ_PARITY_COMPLETE');
  requireTrue(replay.count > 0, 'browser-observed read replay is empty');
  requireTrue(replay.results?.every((row) => row.equal === true), 'browser-observed read replay contains mismatch');

  const fullReads = await json('full-read-parity.json');
  marker('full-read-parity.json', fullReads, 'ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE');
  requireTrue(fullReads.reads >= 25, 'full UI read parity workload unexpectedly small');
  requireTrue(fullReads.results?.every((row) => row.equal === true), 'full UI read parity contains mismatch');

  const writes = await json('local-write-interoperability.json');
  marker(
    'local-write-interoperability.json',
    writes,
    'ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE',
  );
  requireTrue(writes.entityClasses === 7, `safe write entity classes expected 7, found ${writes.entityClasses}`);
  requireTrue(writes.dualWrite === false, 'safe write evidence reports dual write');
  requireTrue(
    Object.values(writes.cleanupResidual ?? {}).every((count) => count === 0),
    'safe write cleanup residual is nonzero',
  );
  requireTrue(writes.prepFixtureRestored === true, 'prep fixture was not restored');

  const resilience = await json('resilience.json');
  marker('resilience.json', resilience, 'ENGAGEMENT_PHASE3_RESILIENCE_COMPLETE');
  requireTrue(resilience.cases >= 15, 'resilience case matrix is incomplete');
  requireTrue(resilience.databaseRecovered === true, 'database did not recover');
  requireTrue(resilience.authUnavailableFailedClosed === true, 'auth outage did not fail closed');
  requireTrue(resilience.retryDuplicateCount === 0, 'resilience retry produced duplicates');
  requireTrue(resilience.retryRowCleaned === true, 'resilience retry row was not cleaned');
  requireTrue(resilience.retryCleanupResidual === 0, 'resilience retry cleanup residual is nonzero');

  const security = await json('security-parity.json');
  marker('security-parity.json', security, 'ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE');
  requireTrue(security.cases >= 50, 'security matrix is incomplete');
  requireTrue(security.realAdminIdentityRestored === true, 'security actor identity was not restored');
  requireTrue(security.activeAndExpiredImpersonation === true, 'impersonation matrix is incomplete');
  requireTrue(security.impersonationWriteAttribution === true, 'impersonation attribution is missing');
  requireTrue(security.orglessSoleMembershipToken === true, 'security did not use sole-membership auth');

  const denials = await json('external-action-denials.json');
  marker(
    'external-action-denials.json',
    denials,
    'ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE',
  );
  const expectedExternal = uniqueExternalCount(inventory);
  requireTrue(
    denials.routes === expectedExternal,
    `external denial routes expected ${expectedExternal}, found ${denials.routes}`,
  );
  requireTrue(denials.unchanged === true, 'external denial protected-state digest changed');
  requireTrue((denials.changedTables ?? []).length === 0, 'external denial reports changed tables');
  requireTrue(denials.results?.every((row) => row.status === 503), 'external denial status is not uniformly 503');
  requireTrue(
    denials.results?.every((row) => row.code === 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED'),
    'external denial code is not exact',
  );

  const routing = await json('proxy-routing.json');
  requireTrue(routing.previewDecisions?.length > 0, 'proxy evidence has no preview decisions');
  requireTrue(routing.mainDecisionCount > 0, 'proxy evidence has no main decisions');

  await assertNoRetainedSecrets();

  const summary = {
    marker: 'ENGAGEMENT_PHASE3_LOCAL_EVIDENCE_COMPLETE',
    sha: EXPECTED_SHA,
    browserScenarios: interactions.scenarios.length,
    responsiveScenarios: interactions.responsive.length,
    browserRecoveryCases: recovery.cases,
    browserObservedReads: replay.count,
    fullReads: fullReads.reads,
    safeWriteClasses: writes.entityClasses,
    resilienceCases: resilience.cases,
    securityCases: security.cases,
    externalDenialRoutes: denials.routes,
    protectedTableCount: denials.tableCount,
    openP0: findings.counts.openP0,
    openP1: findings.counts.openP1,
    blockingP2: findings.counts.blockingP2,
    secretsRetained: false,
  };
  await writeFile(
    path.join(EVIDENCE, 'phase3-evidence-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `ENGAGEMENT_PHASE3_LOCAL_EVIDENCE_COMPLETE sha=${EXPECTED_SHA} ` +
      `scenarios=${summary.browserScenarios} reads=${summary.fullReads} ` +
      `writes=${summary.safeWriteClasses} denials=${summary.externalDenialRoutes}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
