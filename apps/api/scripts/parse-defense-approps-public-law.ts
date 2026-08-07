/**
 * Phase 6 Workstream L — legacy public-law loader containment facade.
 *
 * This command is deliberately INSPECT-ONLY. The historical implementation
 * wrote `enacted` directly from a public-law-labeled rows artifact through
 * ProgramElementWriterService. Phase 6 forbids that bypass: enacted line
 * positions require a complete DefenseBudgetEnactmentProofV1 and are projected
 * only through the proof-gated stage cycle. Canonical promotion remains Phase 7.
 */
import * as fs from 'node:fs';
import {
  defenseBudgetEnactmentProofV1Schema,
  enactedLineCandidateV1Schema,
} from '../src/defense-budget/stages/enacted/enactment-proof-v1.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  if (process.argv.includes('--commit')) {
    throw new Error(
      'parse-defense-approps-public-law: canonical enacted commit is disabled in Phase 6; use proof-gated cycle inspection/certification',
    );
  }
  const proofPath = arg('proof');
  const candidatesPath = arg('candidates');
  if (proofPath == null || candidatesPath == null) {
    throw new Error(
      'Usage: parse:defense-approps-public-law -- --proof <enactment-proof.json> --candidates <line-candidates.json>',
    );
  }
  const proof = defenseBudgetEnactmentProofV1Schema.parse(
    JSON.parse(fs.readFileSync(proofPath, 'utf8')),
  );
  const candidatesRaw = JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) as unknown;
  if (!Array.isArray(candidatesRaw)) throw new Error('candidates file must be an array');
  const candidates = candidatesRaw.map((candidate) => enactedLineCandidateV1Schema.parse(candidate));
  console.log(
    JSON.stringify(
      {
        mode: 'INSPECT_ONLY',
        canonicalWrites: false,
        proofId: proof.proofId,
        publicLawNumber: proof.publicLawNumber,
        proofType: proof.proofType,
        candidateCount: candidates.length,
        next: 'verify the Phase 6 enacted proof chain; no canonical promotion is available here',
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
