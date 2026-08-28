#!/usr/bin/env node
/**
 * Phase 10B-5 Part G — governed single expected-source discovery command.
 *
 * Resolves EXACTLY ONE `DefenseBudgetExpectedSource` row (never a sweep of
 * all 56) into an official document candidate, using the pure
 * `resolveExpectedSourceDocument` function. Read-only in every respect:
 *
 *   * reads one expected-source row (SELECT only, via PrismaExpectedSourceCatalog)
 *   * resolves a candidate against the deterministic DW catalog / an optional
 *     recorded listing page
 *   * prints the result
 *
 * This command has NO commit path and writes NO observation, NO outbox row,
 * and NO cycle/expected-source row under any environment or flag combination.
 * Per Phase H of the 10B-5 brief, production observation creation is out of
 * scope for this PR; that remains the governed watcher's job
 * (`lifecycle-watch --commit`), invoked separately once this resolver is
 * reviewed and shipped.
 *
 * Usage:
 *   node scripts/discover-expected-source.mjs --expected-source-id <uuid> [--dry-run]
 *   node scripts/discover-expected-source.mjs --dedup-key <64hex> [--dry-run]
 *
 * `--dry-run` is accepted for explicitness but has no effect: every run of
 * this command is a dry run.
 */

import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');

const dist = (relative) => require(path.join(appRoot, 'dist/budget-lifecycle', relative));
function loadDomain() {
  try {
    return require('@capiro/defense-domain');
  } catch {
    return require(path.join(repoRoot, 'packages/defense-domain/dist/index.js'));
  }
}
const domain = loadDomain();

const {
  JobPreflightError,
  resolveDatabaseIdentity,
  printTargetIdentity,
} = require(path.join(appRoot, 'scripts/job-preflight.mjs'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : (args[index + 1] ?? null);
};

const expectedSourceId = value('expected-source-id');
const dedupKey = value('dedup-key');

if (!expectedSourceId && !dedupKey) {
  console.error(
    'usage: discover-expected-source.mjs --expected-source-id <uuid> | --dedup-key <64hex> [--dry-run]',
  );
  process.exit(64);
}

const { SourceAdapterRegistry } = dist('source-adapter.registry.js');
const registry = new SourceAdapterRegistry();

let prisma = null;
function openPrisma(identity) {
  process.env.DATABASE_URL = identity.url;
  const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
  return new PrismaClient();
}

async function loadOneExpectedSource() {
  const identity = resolveDatabaseIdentity();
  printTargetIdentity({ mode: 'discover-expected-source', commit: false, identity });
  prisma = openPrisma(identity);

  const clause = expectedSourceId ? 'es.id = $1::uuid' : 'es.dedup_key = $1';
  const param = expectedSourceId ?? dedupKey;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT es.id::text AS id, es.dedup_key, es.fiscal_year, es.authority_track,
            es.source_family, es.stage, es.chamber, es.committee, es.component,
            es.adapter_id, es.expected_state
       FROM defense_budget_expected_source es
      WHERE ${clause}
      LIMIT 1`,
    param,
  );

  return rows[0] ?? null;
}

async function main() {
  const row = await loadOneExpectedSource();
  if (!row) {
    console.error(
      `[phase10b5-discover] no expected source matched ` +
        `${expectedSourceId ? `id=${expectedSourceId}` : `dedupKey=${dedupKey}`}`,
    );
    console.log('PHASE10B5_DISCOVER_NOT_FOUND');
    return 1;
  }

  console.log(
    `[phase10b5-discover] expectedSourceId=${row.id} dedupKey=${row.dedup_key.slice(0, 12)}... ` +
      `FY${row.fiscal_year} track=${row.authority_track} family=${row.source_family} ` +
      `stage=${row.stage} component=${row.component ?? '(none)'} adapter=${row.adapter_id} ` +
      `expectedState=${row.expected_state}`,
  );

  if (!registry.has(row.adapter_id)) {
    console.error(`[phase10b5-discover] adapter ${row.adapter_id} is not registered`);
    console.log('PHASE10B5_DISCOVER_UNSUPPORTED_ADAPTER');
    return 1;
  }
  const adapter = registry.get(row.adapter_id);

  const resolution = domain.resolveExpectedSourceDocument({
    expectedSource: {
      fiscalYear: row.fiscal_year,
      authorityTrack: row.authority_track,
      sourceFamily: row.source_family,
      stage: row.stage,
      chamber: row.chamber,
      committee: row.committee,
      component: row.component,
      adapterId: row.adapter_id,
      dedupKey: row.dedup_key,
    },
    officialHosts: adapter.officialHosts,
  });

  console.log(`[phase10b5-discover] outcome=${resolution.outcome}`);
  for (const reason of resolution.reasons) console.log(`[phase10b5-discover] reason: ${reason}`);

  if (resolution.outcome === 'resolved' && resolution.candidate) {
    console.log(`[phase10b5-discover] resolvedUrl=${resolution.candidate.url}`);
    console.log(`[phase10b5-discover] detectedFiscalYear=${resolution.candidate.detectedFiscalYear}`);
    console.log(`[phase10b5-discover] detectedSourceFamily=${resolution.candidate.detectedSourceFamily}`);
    console.log(`[phase10b5-discover] detectedComponent=${resolution.candidate.detectedComponent ?? '(none)'}`);
    console.log(`[phase10b5-discover] title=${resolution.candidate.title ?? '(none)'}`);
    console.log(`[phase10b5-discover] candidateIdentity=${resolution.expectedSourceDedupKey.slice(0, 16)}...`);
  }

  if (resolution.outcome === 'ambiguous') {
    console.log(`[phase10b5-discover] ambiguousCandidates=${resolution.ambiguousCandidates.length}`);
    for (const candidate of resolution.ambiguousCandidates) {
      console.log(`  ${candidate.url}`);
    }
  }

  console.log(
    '[phase10b5-discover] zero lifecycle mutation: no observation, outbox, or expected-source row ' +
      'was created or touched by this command.',
  );
  console.log('PHASE10B5_DISCOVER_REPORTED');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof JobPreflightError) {
      console.error(`[phase10b5-discover] ${error.message}`);
      process.exit(error.exitCode ?? 78);
    }
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
  });
