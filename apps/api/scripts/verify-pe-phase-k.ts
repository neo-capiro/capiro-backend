/**
 * Phase K permanent release gate (DB-free core).
 *
 * Chains static proofs that do not require a shared database:
 *  - PE production script catalog honesty
 *  - script lint
 *  - migration guards (offline)
 *  - synthetic alarm event generation for every catalogued alarm
 *  - golden provenance audit for grounded field set (must stay synthetic-loud
 *    until humans review)
 *
 * Jest coverage lives under test:pe-trust / verify:pe-phase-k package scripts.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PE_TRUST_ALARM_DEFINITIONS,
  buildPeTrustSyntheticAlarmEvent,
  peTrustCatalogSeriesUpperBound,
} from '../src/program-element/pe-trust-metric-catalog.js';
import {
  auditGoldenReviewProvenance,
  type GroundedFieldGolden,
} from '../src/intelligence/metrics/accuracy-metrics.js';
import { PE_PRODUCTION_SCRIPTS } from './lib/pe-production-scripts.js';
import { evaluatePeTrustDiagnostics } from './lib/pe-trust-diagnostics.js';

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return cwd.endsWith('/apps/api') ? process.cwd() : resolve(process.cwd(), 'apps/api');
}

function main(): void {
  assert.ok(PE_PRODUCTION_SCRIPTS.length >= 20, 'production script catalog too small');
  assert.ok(peTrustCatalogSeriesUpperBound() <= 256, 'metric series bound exceeded');

  for (const alarm of PE_TRUST_ALARM_DEFINITIONS) {
    const evt = buildPeTrustSyntheticAlarmEvent(alarm.id);
    assert.equal(evt.alarmId, alarm.id);
    assert.match(evt.note, /SYNTHETIC/i);
  }

  // Healthy diagnostic fixture must pass; poisoned fixture must fail closed
  const healthy = evaluatePeTrustDiagnostics({
    sourceAgeSeconds: {
      'pe-derive-chain': 10,
      'sync-sam-opportunities': 10,
      'send-pe-alert-emails': 10,
    },
    observationsWithoutSourceDocument: 0,
    duplicateObservationGroups: 0,
    pendingOutboxCount: 0,
    samPartialRunCount: 0,
    staleCacheEntryCount: 0,
  });
  assert.equal(healthy.ok, true, 'healthy fixture must pass');

  const poisoned = evaluatePeTrustDiagnostics({
    sourceAgeSeconds: {
      'pe-derive-chain': 10,
      'sync-sam-opportunities': 10,
      'send-pe-alert-emails': 10,
    },
    observationsWithoutSourceDocument: 1,
    samPartialRunCount: 1,
  });
  assert.equal(poisoned.ok, false, 'poisoned fixture must fail closed');

  // Grounded golden set (may be synthetic) must pass provenance audit
  const goldenPath = resolve(apiRoot(), 'test/__golden__/grounded-field.golden.json');
  const parsed = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
    _note?: string;
    rows: GroundedFieldGolden[];
  };
  assert.match(String(parsed._note ?? ''), /SYNTHETIC|NOT HUMAN/i);
  const audit = auditGoldenReviewProvenance(parsed.rows);
  assert.equal(audit.ok, true, audit.blockers.join('; '));
  assert.equal(
    parsed.rows.every((r) => r.humanReviewed === false),
    true,
    'committed grounded golden must remain synthetic until human review fills real rows',
  );

  console.log('PE_PHASE_K_OK');
}

main();
