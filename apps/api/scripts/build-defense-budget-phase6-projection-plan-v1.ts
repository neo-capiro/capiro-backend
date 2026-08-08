/**
 * build-defense-budget-phase6-projection-plan-v1 (Phase 7 Gap 5, decisions
 * A1-A4) — the I/O half of the Phase 6 projection-plan builder.
 *
 * Phase 6 Gap 5 decision A4 keeps the builder pure: `buildPhase6Projection
 * PlanDocumentV1` (`phase6-projection-plan-builder-v1.ts`) never imports
 * Prisma and never reads a database. This script is the one place that does —
 * read-only, through the MAIN application `PrismaClient`'s raw SQL, the same
 * pattern `phase6-audit-projection-repository-prisma-v1.ts` and
 * `promotion-projection-source-prisma-v1.ts` already use for this exact table.
 * No second `PrismaClient` against `.prisma/phase6-projection-client` — that
 * generated client's only job is `prisma generate`/`validate` and migration
 * history for this schema, matching the rationale already recorded on the
 * audit-projection repository. It loads every non-superseded audit projection
 * for a cycle and fiscal year, reconstructs the exact `Phase6NativeProjectionV1`
 * rows, calls the pure builder, and prints the resulting plan document.
 *
 *   build-defense-budget-phase6-projection-plan-v1 \
 *     --cycle-id <id> --fiscal-year <fy> [--out <plan.json>]
 *
 * No `--commit`, no write mode, no flag that could ever add one — this reads
 * one table and prints JSON. Filing the result is a separate step:
 *
 *   build-defense-budget-phase6-projection-plan-v1 --cycle-id c --fiscal-year 2027 \
 *     > plan.json
 *   persist-defense-budget-projection-plan-v1 --plan plan.json --family committee \
 *     --producer-version build-defense-budget-phase6-projection-plan-v1@1 \
 *     --certification-sha256 <phase6_cycle_certification.content_sha256> \
 *     --certification-id <phase6_cycle_certification.id> \
 *     --commit
 *
 * Money is read back through `parseCanonicalDecimalString`: Postgres pads
 * `NUMERIC(24,9)` to full scale (`125` reads back as `125.000000000`), which is
 * not canonical decimal form, and `moneyValueV1Schema` refuses it uncorrected.
 *
 * Exit codes: 0 built (even an empty plan — an empty cycle is a legitimate
 * state, not an error), 2 usage, 1 error.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import { parseCanonicalDecimalString } from '../src/defense-budget/contracts/decimal-string.js';
import { buildPhase6ProjectionPlanDocumentV1 } from '../src/defense-budget/phase6/phase6-projection-plan-builder-v1.js';
import type { Phase6NativeProjectionV1 } from '../src/defense-budget/phase6/phase6-native-projection-v1.js';
import type { MoneyUnitV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface AuditProjectionRowV1 {
  projectionId: string;
  naturalKey: string;
  idempotencyKey: string;
  projectionKind: string;
  verificationCandidateId: string;
  verificationRunId: string;
  artifactId: string;
  artifactContentSha256: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  sourceProfileHash: string;
  nativeIdentityHash: string;
  track: string;
  stage: string;
  fundingField: string | null;
  originalValue: string | null;
  originalUnit: string | null;
  amountMillions: unknown;
  directOrDerived: string;
  evidenceIds: unknown;
  bindingStatus: string;
  projectionStatus: string;
  enactmentProofId: string | null;
  payload: unknown;
}

function toNativeProjectionV1(row: AuditProjectionRowV1): Phase6NativeProjectionV1 {
  const hasMoney =
    row.originalValue != null && row.originalUnit != null && row.amountMillions != null;
  return {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: row.projectionId,
    naturalKey: row.naturalKey,
    idempotencyKey: row.idempotencyKey,
    projectionKind: row.projectionKind as Phase6NativeProjectionV1['projectionKind'],
    verificationCandidateId: row.verificationCandidateId,
    verificationRunId: row.verificationRunId,
    artifactId: row.artifactId,
    artifactContentSha256: row.artifactContentSha256,
    sourceDocumentId: row.sourceDocumentId,
    sourcePdfSha256: row.sourcePdfSha256,
    sourceProfileHash: row.sourceProfileHash,
    nativeIdentityHash: row.nativeIdentityHash,
    track: row.track as Phase6NativeProjectionV1['track'],
    stage: row.stage as Phase6NativeProjectionV1['stage'],
    ...(row.fundingField != null
      ? { fundingField: row.fundingField as Phase6NativeProjectionV1['fundingField'] }
      : {}),
    ...(hasMoney
      ? {
          money: {
            originalValue: row.originalValue!,
            originalUnit: row.originalUnit as MoneyUnitV1,
            valueMillions: parseCanonicalDecimalString(String(row.amountMillions)),
          },
        }
      : {}),
    directOrDerived: row.directOrDerived as Phase6NativeProjectionV1['directOrDerived'],
    evidenceIds: (row.evidenceIds as string[] | null) ?? [],
    bindingStatus: row.bindingStatus as Phase6NativeProjectionV1['bindingStatus'],
    projectionStatus: row.projectionStatus as Phase6NativeProjectionV1['projectionStatus'],
    ...(row.enactmentProofId != null ? { enactmentProofId: row.enactmentProofId } : {}),
    payload: (row.payload as Phase6NativeProjectionV1['payload'] | null) ?? {},
    canonicalWriteAllowed: false,
  };
}

async function main(): Promise<number> {
  const cycleId = arg('cycle-id');
  const fiscalYearRaw = arg('fiscal-year');
  if (cycleId == null) throw new Error('--cycle-id <id> is required');
  if (fiscalYearRaw == null) throw new Error('--fiscal-year <year> is required');
  const fiscalYear = Number.parseInt(fiscalYearRaw, 10);
  if (!Number.isInteger(fiscalYear)) throw new Error('--fiscal-year must be an integer');
  const outPath = arg('out');

  const prisma = new PrismaClient();
  try {
    // Read-only: no create/update/delete anywhere in this script. Every row
    // that is not superseded is read — the pure builder, not this query,
    // decides what becomes a candidate and how.
    const rows = await prisma.$queryRawUnsafe<AuditProjectionRowV1[]>(
      `SELECT "projection_id"             AS "projectionId",
              "natural_key"               AS "naturalKey",
              "idempotency_key"           AS "idempotencyKey",
              "projection_kind"           AS "projectionKind",
              "verification_candidate_id" AS "verificationCandidateId",
              "verification_run_id"       AS "verificationRunId",
              "artifact_id"               AS "artifactId",
              "artifact_content_sha256"   AS "artifactContentSha256",
              "source_document_id"        AS "sourceDocumentId",
              "source_pdf_sha256"         AS "sourcePdfSha256",
              "source_profile_hash"       AS "sourceProfileHash",
              "native_identity_hash"      AS "nativeIdentityHash",
              "track", "stage",
              "funding_field"             AS "fundingField",
              "original_value"            AS "originalValue",
              "original_unit"             AS "originalUnit",
              "amount_millions"::text     AS "amountMillions",
              "direct_or_derived"         AS "directOrDerived",
              "evidence_ids_jsonb"        AS "evidenceIds",
              "binding_status"            AS "bindingStatus",
              "projection_status"         AS "projectionStatus",
              "enactment_proof_id"        AS "enactmentProofId",
              "payload_jsonb"             AS "payload"
         FROM "phase6_audit_projection"
        WHERE "projection_status" != 'superseded'
          AND ("payload_jsonb"->>'fiscalYear')::int = $1
        ORDER BY "natural_key", "projection_id"`,
      fiscalYear,
    );

    const document = buildPhase6ProjectionPlanDocumentV1({
      cycleId,
      fiscalYear,
      rows: rows.map(toNativeProjectionV1),
    });

    const json = `${JSON.stringify(document, null, 2)}\n`;
    if (outPath != null) {
      fs.writeFileSync(outPath, json);
    } else {
      process.stdout.write(json);
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
