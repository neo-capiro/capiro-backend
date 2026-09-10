import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { factTextFromValue } from '../learning/learning-signal-fact-content.helpers.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';

interface SourceMemory {
  sourceType: string;
  sourceRef?: string | null;
  originSurface?: string | null;
  sourceId: string | null;
  clientId: string | null;
  memoryScope: string;
}

interface AcceptedFinding {
  tenantId: string;
  clientId: string;
  signalId: string;
  findingId: string;
  runId: string;
  status: string;
  proposedValue: unknown;
  evidence: unknown;
  reviewedAt: Date | null;
}

export type GovernedMemorySourceEvidence =
  | { status: 'unavailable'; explanation: string }
  | {
      status: 'available';
      explanation: string;
      findingId: string;
      runId: string;
      factText: string;
      acceptedAt: string | null;
      links: Array<{ label: string; url: string }>;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable: GovernedMemorySourceEvidence = {
  status: 'unavailable',
  explanation:
    'The original accepted finding is unavailable in this client scope. Review the original source before suggesting a correction. The approved memory has not changed.',
};

/**
 * Called only after the existing governed item-detail read authorizes the item.
 * Resolve the durable CRM finding, never a title-derived ID or private chat note.
 * Recheck client access inside the same transaction and require both source rows
 * to belong to that exact tenant/client. This is evidence for a human correction,
 * not a replacement of approved sections, a new candidate, or a memory write.
 */
export async function readGovernedMemorySourceEvidence(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  memory: SourceMemory,
): Promise<GovernedMemorySourceEvidence | null> {
  const learningCapture = memory.sourceType === 'learning_signal_capture';
  // Pre-governance captures retained these two provenance fields but had no
  // typed source. The durable signal join below must still prove the source.
  const legacyCapture =
    memory.sourceType === 'unknown' &&
    memory.sourceRef === 'learning_signal' &&
    memory.originSurface === 'learning_signal';
  if ((!learningCapture && !legacyCapture) || memory.memoryScope !== 'client') return null;
  if (!memory.clientId || !memory.sourceId || !UUID.test(memory.sourceId)) return unavailable;
  if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, memory.clientId)))
    return unavailable;

  const rows = await tx.$queryRaw<AcceptedFinding[]>(Prisma.sql`
    SELECT f.tenant_id::text AS "tenantId", f.client_id::text AS "clientId",
           ls.id::text AS "signalId", f.id::text AS "findingId", f.run_id::text AS "runId",
           f.status, f.proposed_value_jsonb AS "proposedValue",
           f.evidence_jsonb AS evidence, f.reviewed_at AS "reviewedAt"
    FROM learning_signal ls
    JOIN client_profile_fill_finding f
      ON f.id = ls.source_object_id AND f.tenant_id = ls.tenant_id
      AND f.client_id = ls.client_id
      AND (ls.source_run_id IS NULL OR f.run_id = ls.source_run_id)
    WHERE ls.id = ${memory.sourceId}::uuid AND ls.tenant_id = ${ctx.tenantId}::uuid
      AND ls.client_id = ${memory.clientId}::uuid
      AND ls.source_surface = 'crm.fill_with_meri'
      AND ls.signal_type = 'crm_finding_accepted'
      AND ls.source_object_type = 'client_profile_fill_finding'
      AND f.tenant_id = ${ctx.tenantId}::uuid AND f.client_id = ${memory.clientId}::uuid
      AND f.status = 'accepted'
    LIMIT 1
  `);
  const row = rows[0];
  if (
    !row ||
    row.tenantId !== ctx.tenantId ||
    row.clientId !== memory.clientId ||
    row.signalId !== memory.sourceId ||
    row.status !== 'accepted'
  )
    return unavailable;
  const factText = factTextFromValue(row.proposedValue);
  if (!factText) return unavailable;
  return {
    status: 'available',
    explanation:
      'This is the original accepted client finding. Review its evidence before using Suggest correction. The approved memory above remains unchanged until a correction is approved.',
    findingId: row.findingId,
    runId: row.runId,
    factText,
    acceptedAt: row.reviewedAt?.toISOString() ?? null,
    links: sourceLinks(row.evidence),
  };
}

/** Expose only source link labels/URLs, never arbitrary evidence payloads or mail bodies. */
function sourceLinks(evidence: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(evidence)) return [];
  const links = new Map<string, { label: string; url: string }>();
  for (const entry of evidence.slice(0, 20)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.url !== 'string' || row.url.length > 2000) continue;
    try {
      const url = new URL(row.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
      const label =
        typeof row.label === 'string' && row.label.trim()
          ? row.label.trim().slice(0, 500)
          : 'Original source';
      links.set(url.href, { label, url: url.href });
    } catch {
      /* An invalid URL is not a usable source link. */
    }
  }
  return [...links.values()];
}
