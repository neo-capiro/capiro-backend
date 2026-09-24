import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

export interface FederalEvidenceOutboxPayload {
  eventKey: string;
  sourceKey: string;
  billId: string | null;
  eventType: string;
  candidateKey: string;
  rawMention: string;
  canonicalPeCode: string | null;
  previousRevisionId: string | null;
  currentRevisionId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  historical: boolean;
}

interface ClaimedRow {
  id: string;
  dedupeKey: string;
  payload: unknown;
  leaseToken: string;
}

interface RecipientRow {
  tenantId: string;
  clientId: string | null;
}

export interface FederalEvidenceDrainResult {
  claimed: number;
  processed: number;
  failed: number;
  alertsInserted: number;
  suppressedHistorical: number;
}

function asPayload(value: unknown): FederalEvidenceOutboxPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('FEDERAL_EVIDENCE_OUTBOX_PAYLOAD_MALFORMED');
  const payload = value as Partial<FederalEvidenceOutboxPayload>;
  if (!payload.eventKey || !payload.sourceKey || !payload.eventType)
    throw new Error('FEDERAL_EVIDENCE_OUTBOX_PAYLOAD_INCOMPLETE');
  return payload as FederalEvidenceOutboxPayload;
}

async function claimOne(prisma: PrismaClient): Promise<ClaimedRow | null> {
  const leaseToken = randomUUID();
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    WITH candidate AS (
      SELECT id
        FROM federal_evidence_change_outbox
       WHERE available_at <= clock_timestamp()
         AND (
           status IN ('pending', 'failed') OR
           (status = 'processing' AND lease_until < clock_timestamp())
         )
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE federal_evidence_change_outbox o
       SET status = 'processing', attempts = attempts + 1,
           lease_token = ${leaseToken}::uuid,
           lease_until = clock_timestamp() + interval '5 minutes',
           last_error = NULL
      FROM candidate c
     WHERE o.id = c.id
    RETURNING o.id, o.dedupe_key AS "dedupeKey", o.payload_jsonb AS payload,
              o.lease_token AS "leaseToken"`;
  return rows[0] ?? null;
}

function eventCopy(payload: FederalEvidenceOutboxPayload): { title: string; description: string } {
  const code = payload.canonicalPeCode ?? payload.rawMention;
  const noun = payload.candidateKey === '__document__' ? 'Legislative text' : `Program ${code}`;
  const labels: Record<string, string> = {
    text_changed: 'changed',
    added: 'was added',
    changed: 'changed',
    removed: 'was removed',
    reinstated: 'was reinstated',
    resolved: 'was linked from retained evidence',
    action_added: 'has a new legislative action',
  };
  const action = labels[payload.eventType] ?? payload.eventType.replaceAll('_', ' ');
  return {
    title: `${noun} ${action}`,
    description: `${noun} ${action} in ${payload.sourceKey}. The source revision and before/after evidence are retained.`,
  };
}

async function deliverClaim(
  prisma: PrismaClient,
  claim: ClaimedRow,
): Promise<{ alertsInserted: number; suppressedHistorical: number }> {
  const payload = asPayload(claim.payload);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM federal_evidence_change_outbox
       WHERE id = ${claim.id}::uuid AND status = 'processing'
         AND lease_token = ${claim.leaseToken}::uuid
         AND lease_until > clock_timestamp()
       FOR UPDATE`;
    if (!locked.length) return { alertsInserted: 0, suppressedHistorical: 0 };
    if (payload.historical) {
      await tx.$executeRaw`
        UPDATE federal_evidence_change_outbox
           SET status = 'processed', processed_at = clock_timestamp(),
               lease_token = NULL, lease_until = NULL
         WHERE id = ${claim.id}::uuid AND lease_token = ${claim.leaseToken}::uuid`;
      return { alertsInserted: 0, suppressedHistorical: 1 };
    }

    const recipients = await tx.$queryRaw<RecipientRow[]>`
      SELECT DISTINCT recipients.tenant_id AS "tenantId", recipients.client_id AS "clientId"
        FROM (
          SELECT tenant_id, client_id
            FROM tracked_bill
           WHERE ${payload.billId}::text IS NOT NULL AND bill_id = ${payload.billId}
          UNION ALL
          SELECT tenant_id, NULL::uuid AS client_id
            FROM program_element_watch
           WHERE ${payload.canonicalPeCode}::text IS NOT NULL
             AND pe_code = ${payload.canonicalPeCode}
          UNION ALL
          SELECT tenant_id, client_id
            FROM client_capabilities
           WHERE ${payload.canonicalPeCode}::text IS NOT NULL
             AND (pe_number = ${payload.canonicalPeCode} OR ${payload.canonicalPeCode} = ANY(pe_numbers))
        ) recipients`;
    const byTenant = new Map<string, Set<string>>();
    for (const recipient of recipients) {
      const ids = byTenant.get(recipient.tenantId) ?? new Set<string>();
      if (recipient.clientId) ids.add(recipient.clientId);
      byTenant.set(recipient.tenantId, ids);
    }
    const copy = eventCopy(payload);
    let alertsInserted = 0;
    for (const [tenantId, ids] of byTenant) {
      const clientIds = [...ids];
      const clientArray = clientIds.length
        ? Prisma.sql`ARRAY[${Prisma.join(clientIds.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`
        : Prisma.sql`ARRAY[]::uuid[]`;
      const dedupeKey = `${claim.dedupeKey}:tenant:${tenantId}`;
      const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO intelligence_change(
          id, source, change_type, severity, title, description,
          related_client_ids, related_issues, related_pe_codes, data, detected_at,
          consumed, dedupe_key
        ) VALUES (
          gen_random_uuid(), 'federal_legislative_evidence', ${payload.eventType},
          ${payload.eventType === 'removed' || payload.eventType === 'changed' ? 'notable' : 'info'},
          ${copy.title}, ${copy.description}, ${clientArray}, ARRAY[]::text[],
          ${payload.canonicalPeCode ? Prisma.sql`ARRAY[${payload.canonicalPeCode}]::text[]` : Prisma.sql`ARRAY[]::text[]`},
          ${JSON.stringify({ ...payload, tenantId, outboxDedupeKey: claim.dedupeKey })}::jsonb,
          clock_timestamp(), false, ${dedupeKey}
        ) ON CONFLICT (dedupe_key) DO NOTHING`);
      alertsInserted += inserted;
    }
    await tx.$executeRaw`
      UPDATE federal_evidence_change_outbox
         SET status = 'processed', processed_at = clock_timestamp(),
             lease_token = NULL, lease_until = NULL, last_error = NULL
       WHERE id = ${claim.id}::uuid AND lease_token = ${claim.leaseToken}::uuid`;
    return { alertsInserted, suppressedHistorical: 0 };
  });
}

async function failClaim(prisma: PrismaClient, claim: ClaimedRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.$executeRaw`
    UPDATE federal_evidence_change_outbox
       SET status = 'failed', last_error = ${message.slice(0, 4000)},
           available_at = clock_timestamp() + interval '1 minute' * LEAST(60, GREATEST(1, attempts)),
           lease_token = NULL, lease_until = NULL
     WHERE id = ${claim.id}::uuid AND lease_token = ${claim.leaseToken}::uuid
       AND status = 'processing'`;
}

/**
 * Leased, bounded and retry-safe delivery. The alert write and outbox ack share
 * one transaction; dedupe_key also protects retries after an uncertain result.
 */
export async function drainFederalEvidenceOutbox(
  prisma: PrismaClient,
  limit = 50,
): Promise<FederalEvidenceDrainResult> {
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  const result: FederalEvidenceDrainResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    alertsInserted: 0,
    suppressedHistorical: 0,
  };
  for (let index = 0; index < bounded; index += 1) {
    const claim = await claimOne(prisma);
    if (!claim) break;
    result.claimed += 1;
    try {
      const delivered = await deliverClaim(prisma, claim);
      result.processed += 1;
      result.alertsInserted += delivered.alertsInserted;
      result.suppressedHistorical += delivered.suppressedHistorical;
    } catch (error) {
      result.failed += 1;
      await failClaim(prisma, claim, error);
    }
  }
  return result;
}
