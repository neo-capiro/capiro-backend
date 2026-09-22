import type { MeriCitation } from '@capiro/shared';
import {
  checkExactSourceEligibility,
  extractMaterialClaims,
  isDocumentSpecificClaim,
  type ClaimLedger,
  type DocumentReference,
  type ExactSourceEligibilityReason,
  type MaterialClaim,
} from '@capiro/meriv2-core';

export interface ClaimInventoryShadowLogger {
  log(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface ClaimInventoryShadowInput {
  conversationId?: string;
  turnId?: string;
  replyText: string;
  citations: readonly MeriCitation[];
  ledger?: ClaimLedger;
  asOf: string;
  logger: ClaimInventoryShadowLogger;
  deadlineMs?: number;
  setTimer?: typeof setTimeout;
  afterInventory?: () => void | Promise<void>;
}

/**
 * Schedules assessment on a later task, so the caller can emit and return the
 * answer first. Stage 1 treats enforce exactly like shadow and never mutates it.
 */
export function scheduleClaimInventoryShadow(input: ClaimInventoryShadowInput): void {
  const setTimer = input.setTimer ?? setTimeout;
  setTimer(() => {
    const startedAt = Date.now();
    const deadlineMs = input.deadlineMs ?? 2_000;
    const deadline = new Promise<'deadline'>((resolve) => setTimer(() => resolve('deadline'), deadlineMs));
    const work = Promise.resolve().then(() => buildClaimInventoryEvent(input, startedAt));
    void Promise.race([work, deadline])
      .then((result) => {
        if (result === 'deadline') {
          input.logger.warn('meri.claim_inventory.failed', {
            conversationId: input.conversationId ?? null,
            turnId: input.turnId ?? null,
            reason: 'deadline',
          });
          return;
        }
        input.logger.log('meri.claim_inventory', result);
        if (input.afterInventory) void Promise.resolve(input.afterInventory()).catch((error: unknown) => {
          input.logger.warn('meri.evidence_shadow.failed', {
            conversationId: input.conversationId ?? null,
            turnId: input.turnId ?? null,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      })
      .catch((error: unknown) => {
        input.logger.warn('meri.claim_inventory.failed', {
          conversationId: input.conversationId ?? null,
          turnId: input.turnId ?? null,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }, 0);
}

export function buildClaimInventoryEvent(
  input: Omit<ClaimInventoryShadowInput, 'setTimer' | 'deadlineMs' | 'afterInventory'>,
  startedAt = Date.now(),
): Record<string, unknown> {
  const claims = extractMaterialClaims({
    replyText: input.replyText,
    citations: input.citations,
    ledger: input.ledger,
    asOf: input.asOf,
  });
  const materialClaims = claims.filter((claim) => claim.material);
  const references = documentReferences(input.citations);
  const failures: Partial<Record<ExactSourceEligibilityReason, number>> = {};
  let documentClaims = 0;
  for (const claim of materialClaims) {
    if (!isDocumentSpecificClaim(claim, input.ledger)) continue;
    documentClaims += 1;
    const eligibility = checkExactSourceEligibility(claim, references, input.ledger);
    if (!eligibility.eligible) failures[eligibility.reason] = (failures[eligibility.reason] ?? 0) + 1;
  }
  return {
    conversationId: input.conversationId ?? null,
    turnId: input.turnId ?? null,
    claims: claims.length,
    material: materialClaims.length,
    uncited: materialClaims.filter((claim) => claim.uncited).length,
    compound: materialClaims.filter((claim) => claim.compound).length,
    byKind: countBy(materialClaims, (claim) => claim.kind),
    byCategory: countBy(materialClaims, (claim) => claim.category),
    documentClaims,
    eligibilityFailures: failures,
    durationMs: Date.now() - startedAt,
  };
}

function documentReferences(citations: readonly MeriCitation[]): DocumentReference[] {
  return citations.flatMap((citation) => {
    const evidence = citation.documentEvidence;
    if (!evidence) return [];
    const recordId = typeof evidence.record.recordId === 'string'
      ? evidence.record.recordId
      : typeof evidence.record.id === 'string'
        ? evidence.record.id
        : null;
    return [{
      kind: 'client_document' as const,
      id: evidence.documentId,
      filename: citation.title,
      version: evidence.contentHash,
      contentState: recordId ? 'indexed_or_extracted' as const : 'metadata_only' as const,
      readable: Boolean(recordId),
      relevantPassageIds: recordId ? [recordId] : [],
      resolution: 'explicit_id' as const,
      clientId: evidence.clientId,
      requestedClientId: evidence.clientId,
    }];
  });
}

function countBy(
  claims: readonly MaterialClaim[],
  key: (claim: MaterialClaim) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const claim of claims) counts[key(claim)] = (counts[key(claim)] ?? 0) + 1;
  return counts;
}
