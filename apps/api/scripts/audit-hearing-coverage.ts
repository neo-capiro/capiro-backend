/**
 * LegiWatch Live Hearings — Phase 9 launch-readiness audit.
 *
 *   pnpm --filter @capiro/api audit:hearing-coverage -- --json
 *   pnpm --filter @capiro/api audit:hearing-coverage -- \
 *     --evidence-source=MIXED --mode=CUTOVER_VERIFICATION --persist
 *
 * This command supersedes the old parent-only Phase 3 report. It audits every
 * current parent committee and subcommittee, the official observation ledger,
 * canonical provenance, stream/capture outcomes, transcript continuity,
 * runtime freshness, intelligence lag, and the required real/chaos evidence.
 *
 * It never seeds a source and never treats zero observations as full coverage.
 * Without --persist it is read-only. A non-passing report exits 2 unless
 * --no-fail is explicitly supplied.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { LegiWatchPhase9ReadinessService } from '../src/live-hearings/phase9/legiwatch-phase9-readiness.service.js';
import type {
  LegiWatchPhase9EvidenceSource,
  LegiWatchPhase9Mode,
  LegiWatchPhase9ReadinessReport,
} from '../src/live-hearings/phase9/legiwatch-phase9.types.js';
import { boolFlag, flag, numFlag } from './lib/job-flags.js';

dotenvConfig();

async function main(): Promise<void> {
  const asJson = boolFlag('json');
  const persist = boolFlag('persist');
  const noFail = boolFlag('no-fail');
  const evidenceSource = evidenceSourceFlag();
  const mode = modeFlag();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const readiness = app.get(LegiWatchPhase9ReadinessService);
    const options = {
      evidenceSource,
      mode,
      lookbackDays: numFlag('lookback-days', 60),
      lookaheadDays: numFlag('lookahead-days', 30),
      captureGraceMinutes: numFlag('capture-grace-minutes', 15),
      intelligenceLagMinutes: numFlag('intelligence-lag-minutes', 10),
    };
    const result = persist
      ? await readiness.evaluateAndPersist(
          process.env.LEGIWATCH_OPERATOR_ID ?? 'audit-hearing-coverage.ts',
          options,
        )
      : { report: await readiness.evaluate(options), run: null };
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printReport(result.report, result.run?.id ?? null);
    if (!noFail && result.report.status !== 'PASS') process.exitCode = 2;
  } finally {
    await app.close();
  }
}

function printReport(report: LegiWatchPhase9ReadinessReport, runId: string | null): void {
  const c = report.counts;
  console.log(
    `\n[phase9-readiness] ${report.status} mode=${report.mode} evidence=${report.evidenceSource}` +
      `${runId ? ` run=${runId}` : ''}`,
  );
  console.log(
    `  window=${report.windowStart} → ${report.windowEnd}\n` +
      `  bodies=${c.totalBodies} (${c.parentBodies} parent / ${c.subcommitteeBodies} subcommittee)\n` +
      `  observations=${c.officialObservations} represented=${c.representedObservations} ` +
      `conflicts=${c.explicitConflicts} invalid=${c.ignoredInvalidObservations} pending=${c.pendingObservations}\n` +
      `  canonical=${c.canonicalEvents} provenance=${c.canonicalEventsWithProvenance} ` +
      `legacyOnly=${c.legacyOnlyCanonicalEvents} duplicates=${c.duplicateCanonicalEvents}\n` +
      `  eligible=${c.eligibleEvents} outcomes=${c.eventsWithOutcomes} ` +
      `unresolved=${c.unresolvedEvents} duplicateCaptures=${c.duplicateGlobalCaptures}\n` +
      `  transcriptGapWithoutMarker=${c.gapsWithoutMarkers} duplicateSequences=${c.duplicateTranscriptSequences}\n` +
      `  staleJobs=${c.staleJobs} laggingIntelligence=${c.laggingIntelligenceJobs}`,
  );
  console.log(
    `  percentages: disposition=${report.percentages.observationDisposition}% ` +
      `provenance=${report.percentages.canonicalProvenance}% ` +
      `captureOutcome=${report.percentages.captureOutcome}%`,
  );

  console.log('\n[phase9-readiness] gates:');
  for (const gate of report.gates) {
    console.log(
      `  ${gate.status.padEnd(14)} ${gate.key.padEnd(42)} ` +
        `measured=${String(gate.measured)} target=${String(gate.target)} — ${gate.message}`,
    );
  }

  console.log('\n[phase9-readiness] current bodies:');
  for (const body of report.bodies) {
    console.log(
      `  ${body.status.padEnd(28)} ${body.chamber.padEnd(7)} ` +
        `${body.systemCode.padEnd(9)} parent=${(body.parentSystemCode ?? '-').padEnd(9)} ` +
        `source=${body.sourceInheritance.padEnd(7)} healthy=${body.sourcesHealthy}/${body.sourcesRegistered} ` +
        `obs=${body.officialObservations} pending=${body.pendingObservations} ` +
        `events=${body.hearingsObserved} captureOutcomes=${body.captureOutcomes} ` +
        `${body.name}`,
    );
  }

  if (report.blockers.length) {
    console.log(`\n[phase9-readiness] ${report.blockers.length} blocker(s):`);
    for (const blocker of report.blockers) console.log(`  · ${blocker}`);
  }
  if (report.exceptions.length) {
    console.log(
      `\n[phase9-readiness] ${report.exceptions.length} persisted/auditable exception candidate(s).`,
    );
  }
}

function evidenceSourceFlag(): LegiWatchPhase9EvidenceSource {
  const value = (
    flag('evidence-source') ??
    process.env.LEGIWATCH_EVIDENCE_SOURCE ??
    'NONE'
  ).toUpperCase();
  if (!['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED', 'NONE'].includes(value)) {
    throw new Error(
      '--evidence-source must be LIVE, OFFICIAL_ARCHIVE, LOCAL_FIXTURE, MIXED, or NONE',
    );
  }
  return value as LegiWatchPhase9EvidenceSource;
}

function modeFlag(): LegiWatchPhase9Mode {
  const value = (flag('mode') ?? 'READINESS').toUpperCase();
  if (
    ![
      'SHADOW',
      'CANARY',
      'READINESS',
      'CUTOVER_VERIFICATION',
      'ROLLBACK_VERIFICATION',
    ].includes(value)
  ) {
    throw new Error(
      '--mode must be SHADOW, CANARY, READINESS, CUTOVER_VERIFICATION, or ROLLBACK_VERIFICATION',
    );
  }
  return value as LegiWatchPhase9Mode;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      '[audit-hearing-coverage] FAILED',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exit(1);
  });
}
