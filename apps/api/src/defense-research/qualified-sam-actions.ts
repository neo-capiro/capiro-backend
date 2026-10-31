import type { PrismaService } from '../prisma/prisma.service.js';
import { ServiceUnavailableException } from '@nestjs/common';

interface QualifiedActionRow {
  transactionIdentityKey: string; awardIdentityKey: string; parentAwardIdentityKey: string | null;
  sourceSystem: string; sourceTransactionId: string; piid: string; modificationNumber: string;
  actionDate: Date | null; signedObligationDelta: { toString(): string } | null;
  signedOutlayDelta: { toString(): string } | null; correctsIdentityKey: string | null;
  supersedesId: string | null; sourceUrl: string | null; sourceObservedAt: Date;
  recordedAt: Date; contractId: string; runId: string; producerCommit: string; imageDigest: string;
}

/** Requires the reviewed v2 forward migration before activation; never falls back to raw SAM totals. */
export async function readQualifiedSamActions(prisma: Pick<PrismaService, '$queryRaw'>, identityKey: string) {
  // One statement snapshot keeps approval revocation, selected rows and coverage mutually consistent.
  const rows = await prisma.$queryRaw<Array<Partial<QualifiedActionRow> & {
    selectedActions: bigint | null; legacyRows: bigint | null; unresolvedRows: bigint | null;
  }>>`
    WITH requested AS (SELECT ${identityKey}::text AS identity_key), coverage AS (
      SELECT sum(selected_actions)::bigint AS selected_actions, sum(legacy_rows)::bigint AS legacy_rows,
        sum(unresolved_rows)::bigint AS unresolved_rows
      FROM v_defproc_action_coverage_v2, requested
      WHERE award_identity_key = requested.identity_key OR parent_award_identity_key = requested.identity_key
    )
    SELECT a.transaction_identity_key AS "transactionIdentityKey", a.award_identity_key AS "awardIdentityKey",
      a.parent_award_identity_key AS "parentAwardIdentityKey", a.source_system AS "sourceSystem",
      a.source_transaction_id AS "sourceTransactionId", a.piid, a.modification_number AS "modificationNumber",
      a.action_date AS "actionDate", a.obligation_usd AS "signedObligationDelta", a.outlay_usd AS "signedOutlayDelta",
      a.corrects_identity_key AS "correctsIdentityKey", a.supersedes_id AS "supersedesId", a.source_url AS "sourceUrl",
      a.source_observed_at AS "sourceObservedAt", a.recorded_at AS "recordedAt", a.contract_id AS "contractId",
      a.run_id AS "runId", a.producer_commit AS "producerCommit", a.image_digest AS "imageDigest",
      c.selected_actions AS "selectedActions", c.legacy_rows AS "legacyRows", c.unresolved_rows AS "unresolvedRows"
    FROM coverage c CROSS JOIN requested r
    LEFT JOIN v_defproc_action_v2 a ON a.award_identity_key = r.identity_key OR a.parent_award_identity_key = r.identity_key
    ORDER BY a.transaction_identity_key
  `;
  const counts = rows[0];
  const actions = rows.filter((row) => row.transactionIdentityKey != null) as Array<QualifiedActionRow>;
  if (actions.length === 0 && (identityKey.startsWith('usaspending|award|')
    || (counts?.legacyRows ?? 0n) > 0n || (counts?.unresolvedRows ?? 0n) > 0n)) {
    throw new ServiceUnavailableException('Qualified SAM acquisition actions are unavailable; source coverage has not been established.');
  }
  return actions.map((row) => ({
    ...row,
    // Return bounded qualification references, never the provider's raw payload or its personal fields.
    raw: { qualification: { contract: row.contractId, runId: row.runId,
      producerCommit: row.producerCommit, imageDigest: row.imageDigest, coverage: {
        state: 'partial', measure: 'qualified_observed_actions',
        selectedActions: counts?.selectedActions?.toString() ?? '0', legacyRows: counts?.legacyRows?.toString() ?? '0',
        unresolvedRows: counts?.unresolvedRows?.toString() ?? '0',
      } } },
  }));
}
