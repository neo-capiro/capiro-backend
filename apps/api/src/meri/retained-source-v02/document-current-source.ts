import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { EngagementService } from '../../engagement/engagement.service.js';
import {
  prepareDocumentRead,
  projectDocumentRead,
  RetainedDocumentsMondayRefusal,
  type DocumentExecutionPolicy,
  type TrustedClientReadContext,
} from './documents-monday.js';

const fail = (reason: string): never => { throw new RetainedDocumentsMondayRefusal(reason); };
const sha256 = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');

type VisibleAttachment = Awaited<ReturnType<EngagementService['listAttachments']>>[number];
type AttachmentFact = {
  id: string; clientId: string | null; fileName: string; contentType: string;
  byteSize: number | null; calculatedSha256: string | null;
  s3Key: string; lifecycleStatus: string; usable: boolean; blockedReason: string | null;
  viewerMode: string; viewerUserIds: string[];
};

function facts(rows: readonly VisibleAttachment[], clientId: string): AttachmentFact[] {
  const result = rows.map((row) => ({
    id: row.id, clientId: row.clientId, fileName: row.fileName, contentType: row.contentType,
    byteSize: row.byteSize, calculatedSha256: row.calculatedSha256,
    s3Key: row.s3Key, lifecycleStatus: row.lifecycleStatus, usable: row.usable,
    blockedReason: row.blockedReason ?? null, viewerMode: row.viewerMode,
    viewerUserIds: [...row.viewerUserIds].sort(),
  }));
  if (result.some((row) => row.clientId !== clientId)) fail('Document owner returned a foreign client attachment');
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function sameSelectedFacts(before: AttachmentFact[], after: AttachmentFact[], documentId: string | null): void {
  const selected = (rows: AttachmentFact[]) => documentId === null ? rows : rows.filter((row) => row.id === documentId);
  if (documentId !== null && (selected(before).length !== 1 || selected(after).length !== 1) ||
      sha256(selected(before)) !== sha256(selected(after)))
    fail('Current document visibility or source metadata changed during the read');
}

/**
 * The existing EngagementService applies client-parent, viewer, hearing and
 * readiness checks. Re-read that same owner before and after the canonical
 * Meri tool instead of inferring access from the model's selector or a cursor.
 * This function never invokes extraction itself; `readCanonical` does so once.
 */
export async function readWithCurrentDocumentFacts(
  engagement: EngagementService,
  ctx: TenantContext,
  current: TrustedClientReadContext,
  normalizedInput: Record<string, unknown>,
  pricing: DocumentExecutionPolicy | undefined,
  readCanonical: (legacyInput: Record<string, unknown>) => Promise<unknown>,
  now: () => number = Date.now,
  assertActive: () => void = () => {},
): Promise<Record<string, unknown>> {
  if (ctx.tenantId !== current.binding.tenantId || ctx.userId !== current.binding.actorId)
    fail('Document caller differs from delegated task');
  assertActive();
  // The provider-free policy is enforced by the actual extraction owner. It
  // does not supply the missing paid tariff required by Meri allocation.
  const legacyInput = prepareDocumentRead(normalizedInput, current, pricing);
  const documentId = normalizedInput.mode === 'read' ? normalizedInput.documentId as string : null;
  const before = facts(await engagement.listAttachments(ctx, { clientId: current.selectedClientId }), current.selectedClientId);
  assertActive();
  if (documentId !== null && (!before.some((row) => row.id === documentId && row.usable)))
    fail('Document is not currently readable');
  const raw = await readCanonical(legacyInput);
  assertActive();
  let body: Record<string, unknown>;
  try {
    const bytes = JSON.stringify(raw);
    if (!bytes || Buffer.byteLength(bytes, 'utf8') > 16 * 1024 * 1024) fail('Document result exceeds source bound');
    body = JSON.parse(bytes) as Record<string, unknown>;
  } catch { fail('Document result is not JSON'); }
  const after = facts(await engagement.listAttachments(ctx, { clientId: current.selectedClientId }), current.selectedClientId);
  assertActive();
  sameSelectedFacts(before, after, documentId);
  if (documentId === null) {
    const names = before.filter((row) => !normalizedInput.query ||
      row.fileName.toLowerCase().includes((normalizedInput.query as string).toLowerCase()));
    const afterId = normalizedInput.listAfter as string | null;
    const eligible = afterId ? names.filter((row) => row.id > afterId) : names;
    const expected = eligible.slice(0, normalizedInput.limit as number);
    const data = body as { documents?: Array<{ id?: unknown }> };
    if (!Array.isArray(data.documents) || sha256(data.documents.map((row) => row.id)) !== sha256(expected.map((row) => row.id)))
      fail('Canonical document list differs from the same-read visible inventory');
    if (!body.coverage || typeof body.coverage !== 'object' || Array.isArray(body.coverage))
      fail('Canonical document coverage is malformed');
    const coverage = body.coverage as Record<string, unknown>;
    if (coverage.total !== names.length || coverage.truncated !== (eligible.length > expected.length))
      fail('Canonical document coverage differs from current inventory');
    for (const [index, returned] of data.documents.entries()) {
      const source = expected[index]!;
      const row = returned as Record<string, unknown>;
      if (row.fileName !== source.fileName || row.contentType !== source.contentType ||
          row.byteSize !== source.byteSize || row.usable !== source.usable ||
          row.blockedReason !== source.blockedReason)
        fail('Canonical document metadata differs from current inventory');
    }
  } else {
    const row = after.find((candidate) => candidate.id === documentId)!;
    const data = body as { document?: { contentHash?: unknown } };
    if (!row.usable || row.calculatedSha256 !== null && data.document?.contentHash !== row.calculatedSha256)
      fail('Document byte hash or readiness changed during the read');
  }
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail('Invalid source observation time');
  return projectDocumentRead(body, normalizedInput, current, pricing, {
    resultSha256: sha256(body), observedAt: new Date(observedAtMs).toISOString(),
  });
}
