/**
 * build-defense-budget-phase6-projection-plan-v1 (Phase 7 Gap 5, decisions
 * A1-A4) — the I/O half of the Phase 6 projection-plan builder.
 *
 * The pure builder remains Prisma-free. This command loads the EXACT projection
 * set bound to one persisted Phase 6 certification, independently re-validates
 * and re-hashes those rows, and only then produces the committee-family plan.
 * It never reconstructs a cycle from "all rows for this fiscal year".
 *
 *   build-defense-budget-phase6-projection-plan-v1 \
 *     --cycle-id <id> --fiscal-year <fy> \
 *     --certification-sha256 <sha256> [--out <plan.json>]
 *
 * Filing remains a separate action:
 *
 *   persist-defense-budget-projection-plan-v1 --plan plan.json --family committee \
 *     --producer-version build-defense-budget-phase6-projection-plan-v1@2 \
 *     --certification-sha256 <same sha256> \
 *     --certification-id <phase6_cycle_certification.id> \
 *     --commit
 *
 * Historical Phase 6 certifications created before exact projection-set
 * binding have NULL projection_set_sha256/projection_count and are deliberately
 * refused. Rebuild and persist the deterministic Phase 6 cycle instead of
 * guessing which old rows belonged to it.
 *
 * Money is read back through `parseCanonicalDecimalString`: Postgres pads
 * `NUMERIC(24,9)` to full scale (`125` reads back as `125.000000000`), which is
 * not canonical decimal form, and `moneyValueV1Schema` refuses it uncorrected.
 *
 * Exit codes: 0 built (including a legitimately certified empty projection
 * set), 2 usage, 1 integrity/error.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import { parseCanonicalDecimalString } from '../src/defense-budget/contracts/decimal-string.js';
import {
  phase6ProjectionSetSha256V1,
} from '../src/defense-budget/phase6/phase6-cycle-certification-v1.js';
import { buildPhase6ProjectionPlanDocumentV1 } from '../src/defense-budget/phase6/phase6-projection-plan-builder-v1.js';
import {
  phase6NativeProjectionV1Schema,
  type Phase6NativeProjectionV1,
} from '../src/defense-budget/phase6/phase6-native-projection-v1.js';
import type { MoneyUnitV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface CertificationRowV1 {
  certificationId: string;
  cycleId: string;
  fiscalYear: number;
  contentSha256: string;
  projectionSetSha256: string | null;
  projectionCount: number | null;
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
  supersedesProjectionId: string | null;
  payload: unknown;
}

function toNativeProjectionV1(row: AuditProjectionRowV1): Phase6NativeProjectionV1 {
  const hasMoney =
    row.originalValue != null && row.originalUnit != null && row.amountMillions != null;
  return phase6NativeProjectionV1Schema.parse({
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: row.projectionId,
    naturalKey: row.naturalKey,
    idempotencyKey: row.idempotencyKey,
    projectionKind: row.projectionKind,
    verificationCandidateId: row.verificationCandidateId,
    verificationRunId: row.verificationRunId,
    artifactId: row.artifactId,
    artifactContentSha256: row.artifactContentSha256,
    sourceDocumentId: row.sourceDocumentId,
    sourcePdfSha256: row.sourcePdfSha256,
    sourceProfileHash: row.sourceProfileHash,
    nativeIdentityHash: row.nativeIdentityHash,
    track: row.track,
    stage: row.stage,
    ...(row.fundingField != null ? { fundingField: row.fundingField } : {}),
    ...(hasMoney
      ? {
          money: {
            originalValue: row.originalValue!,
            originalUnit: row.originalUnit as MoneyUnitV1,
            valueMillions: parseCanonicalDecimalString(String(row.amountMillions)),
          },
        }
      : {}),
    directOrDerived: row.directOrDerived,
    evidenceIds: (row.evidenceIds as string[] | null) ?? [],
    bindingStatus: row.bindingStatus,
    projectionStatus: row.projectionStatus,
    ...(row.enactmentProofId != null ? { enactmentProofId: row.enactmentProofId } : {}),
    ...(row.supersedesProjectionId != null
      ? { supersedesProjectionId: row.supersedesProjectionId }
      : {}),
    payload: (row.payload as Phase6NativeProjectionV1['payload'] | null) ?? {},
    canonicalWriteAllowed: false,
  });
}

async function main(): Promise<number> {
  const cycleId = arg('cycle-id');
  const fiscalYearRaw = arg('fiscal-year');
  const certificationSha256 = arg('certification-sha256');
  if (cycleId == null) throw new Error('--cycle-id <id> is required');
  if (fiscalYearRaw == null) throw new Error('--fiscal-year <year> is required');
  if (certificationSha256 == null || !/^[0-9a-f]{64}$/.test(certificationSha256)) {
    throw new Error('--certification-sha256 must be 64 lowercase hex characters');
  }
  const fiscalYear = Number.parseInt(fiscalYearRaw, 10);
  if (!Number.isInteger(fiscalYear)) throw new Error('--fiscal-year must be an integer');
  const outPath = arg('out');

  const prisma = new PrismaClient();
  try {
    const certifications = await prisma.$queryRawUnsafe<CertificationRowV1[]>(
      `SELECT "id"::text AS "certificationId",
              "cycle_id" AS "cycleId",
              "fiscal_year" AS "fiscalYear",
              "content_sha256" AS "contentSha256",
              "projection_set_sha256" AS "projectionSetSha256",
              "projection_count" AS "projectionCount"
         FROM "phase6_cycle_certification"
        WHERE "content_sha256" = $1`,
      certificationSha256,
    );
    const certification = certifications[0];
    if (certification == null) {
      throw new Error(`Phase 6 certification ${certificationSha256} was not found`);
    }
    if (certification.cycleId !== cycleId || certification.fiscalYear !== fiscalYear) {
      throw new Error(
        `certification scope mismatch: expected ${cycleId}/FY${fiscalYear}, got ${certification.cycleId}/FY${certification.fiscalYear}`,
      );
    }
    if (
      certification.projectionSetSha256 == null ||
      certification.projectionCount == null
    ) {
      throw new Error(
        'certification predates exact projection-set binding; rebuild and persist the Phase 6 cycle',
      );
    }

    // No status filter: the certification signed the exact rows as they existed.
    // If one is later superseded/changed, the recomputed set hash below changes
    // and this command refuses the stale certification instead of silently
    // dropping the row.
    const rows = await prisma.$queryRawUnsafe<AuditProjectionRowV1[]>(
      `SELECT p."projection_id"             AS "projectionId",
              p."natural_key"               AS "naturalKey",
              p."idempotency_key"           AS "idempotencyKey",
              p."projection_kind"           AS "projectionKind",
              p."verification_candidate_id" AS "verificationCandidateId",
              p."verification_run_id"       AS "verificationRunId",
              p."artifact_id"               AS "artifactId",
              p."artifact_content_sha256"   AS "artifactContentSha256",
              p."source_document_id"        AS "sourceDocumentId",
              p."source_pdf_sha256"         AS "sourcePdfSha256",
              p."source_profile_hash"       AS "sourceProfileHash",
              p."native_identity_hash"      AS "nativeIdentityHash",
              p."track", p."stage",
              p."funding_field"             AS "fundingField",
              p."original_value"            AS "originalValue",
              p."original_unit"             AS "originalUnit",
              p."amount_millions"::text     AS "amountMillions",
              p."direct_or_derived"         AS "directOrDerived",
              p."evidence_ids_jsonb"        AS "evidenceIds",
              p."binding_status"            AS "bindingStatus",
              p."projection_status"         AS "projectionStatus",
              p."enactment_proof_id"        AS "enactmentProofId",
              p."supersedes_projection_id"  AS "supersedesProjectionId",
              p."payload_jsonb"             AS "payload"
         FROM "phase6_cycle_certification_projection" cp
         JOIN "phase6_audit_projection" p
           ON p."projection_id" = cp."projection_id"
        WHERE cp."certification_content_sha256" = $1
        ORDER BY cp."projection_ordinal", p."projection_id"`,
      certificationSha256,
    );
    const projections = rows.map(toNativeProjectionV1);
    if (projections.length !== certification.projectionCount) {
      throw new Error(
        `certification projection count mismatch: expected ${certification.projectionCount}, loaded ${projections.length}`,
      );
    }
    const actualProjectionSetSha256 = phase6ProjectionSetSha256V1(projections);
    if (actualProjectionSetSha256 !== certification.projectionSetSha256) {
      throw new Error(
        `certification projection hash mismatch: expected ${certification.projectionSetSha256}, got ${actualProjectionSetSha256}`,
      );
    }

    const document = buildPhase6ProjectionPlanDocumentV1({
      cycleId,
      fiscalYear,
      rows: projections,
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
