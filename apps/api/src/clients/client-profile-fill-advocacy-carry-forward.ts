export const ADVOCACY_REVIEW_CARRY_FORWARD_KINDS = [
  'advocacy_record',
  'advocacy_outcome',
  'regulatory_outcome',
] as const;

export interface AdvocacyCarryForwardResult {
  carried: number;
  retired: number;
}

interface CarryForwardTransaction {
  $queryRawUnsafe<T>(query: string, ...args: unknown[]): Promise<T>;
}

/**
 * Move unresolved Advocacy review work onto a newly-created Fill-with-Meri run.
 *
 * Advocacy source cursors are client-scoped and deliberately incremental, while
 * findings are run-scoped. Without this bridge, an LDA/FARA/etc. item first
 * discovered in run A can remain `pending`, the source cursor can correctly
 * advance past it, and run B will never see the item because its GET contract
 * only returns run-B findings. The review item still exists in Postgres but has
 * effectively disappeared from the user's current review inbox.
 *
 * This function fixes that mismatch WITHOUT rewinding any source cursor:
 *
 * - lock unresolved Advocacy findings for this tenant/client;
 * - never carry a content hash that has an accepted/rejected terminal decision;
 * - choose only the newest pending row per content hash;
 * - clone it onto the new run with the same evidence/proposal/content hash;
 * - mark prior pending copies informational only after the new copy exists.
 *
 * `client_profile_fill_finding` already has UNIQUE(run_id, content_hash), so a
 * retried invocation for the same run is idempotent. The row locks also keep a
 * concurrent review decision from racing a carry-forward copy.
 *
 * Old rows are retained for audit. No client profile or Advocacy record is
 * written here; this only preserves the review proposal in the active run.
 */
export async function carryForwardPendingAdvocacyFindings(
  tx: CarryForwardTransaction,
  tenantId: string,
  clientId: string,
  newRunId: string,
): Promise<AdvocacyCarryForwardResult> {
  const rows = await tx.$queryRawUnsafe<Array<{ carried: number; retired: number }>>(
    `WITH locked_pending AS (
       SELECT f.*
         FROM client_profile_fill_finding f
        WHERE f.tenant_id = $1::uuid
          AND f.client_id = $2::uuid
          AND f.run_id <> $3::uuid
          AND f.status = 'pending'
          AND f.kind = ANY($4::text[])
        FOR UPDATE
     ),
     eligible AS (
       SELECT DISTINCT ON (pending.content_hash) pending.*
         FROM locked_pending pending
        WHERE NOT EXISTS (
          SELECT 1
            FROM client_profile_fill_finding terminal
           WHERE terminal.tenant_id = pending.tenant_id
             AND terminal.client_id = pending.client_id
             AND terminal.content_hash = pending.content_hash
             AND terminal.status IN ('accepted', 'rejected')
        )
        ORDER BY pending.content_hash, pending.created_at DESC, pending.id DESC
     ),
     inserted AS (
       INSERT INTO client_profile_fill_finding
         (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
          current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence,
          status, content_hash)
       SELECT $3::uuid, eligible.tenant_id, eligible.client_id, eligible.kind,
              eligible.target_key, eligible.source, eligible.fact_kind,
              eligible.current_value_jsonb, eligible.proposed_value_jsonb,
              eligible.evidence_jsonb, eligible.confidence, 'pending',
              eligible.content_hash
         FROM eligible
       ON CONFLICT (run_id, content_hash) DO NOTHING
       RETURNING content_hash
     ),
     retired AS (
       UPDATE client_profile_fill_finding old
          SET status = 'informational', updated_at = now()
        WHERE old.tenant_id = $1::uuid
          AND old.client_id = $2::uuid
          AND old.run_id <> $3::uuid
          AND old.status = 'pending'
          AND old.kind = ANY($4::text[])
          AND EXISTS (
            SELECT 1 FROM inserted
             WHERE inserted.content_hash = old.content_hash
          )
       RETURNING old.id
     )
     SELECT (SELECT COUNT(*)::int FROM inserted) AS carried,
            (SELECT COUNT(*)::int FROM retired) AS retired`,
    tenantId,
    clientId,
    newRunId,
    [...ADVOCACY_REVIEW_CARRY_FORWARD_KINDS],
  );

  return {
    carried: Number(rows[0]?.carried ?? 0),
    retired: Number(rows[0]?.retired ?? 0),
  };
}
