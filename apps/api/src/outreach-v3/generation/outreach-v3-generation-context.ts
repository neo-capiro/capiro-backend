import type { OutreachResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import type { SelectedContextItemRef } from '../../engagement/generation/evidence-source.service.js';
import {
  boundEvidenceText,
  type EvidenceTrust,
} from '../../engagement/generation/evidence-packet.types.js';

export const OUTREACH_V3_GENERATION_CONTEXT_ERROR_CODES = [
  'CONTEXT_SNAPSHOT_CHANGED',
  'CONTEXT_NOT_USABLE_AS_EVIDENCE',
  'WRITING_GUIDANCE_NOT_ALLOWED',
] as const;

export type OutreachV3GenerationContextErrorCode =
  (typeof OUTREACH_V3_GENERATION_CONTEXT_ERROR_CODES)[number];

export class OutreachV3GenerationContextError extends Error {
  constructor(
    readonly code: OutreachV3GenerationContextErrorCode,
    message: string,
    readonly contextKey: string,
  ) {
    super(message);
    this.name = 'OutreachV3GenerationContextError';
  }
}

export interface OutreachV3ServerEvidence {
  contextKey: string;
  sourceType: string;
  sourceId: string;
  title: string;
  /** Already bounded with the exact Evidence Packet bound before ledger creation. */
  text: string;
  truncated: boolean;
  trust: EvidenceTrust;
  clientId: string | null;
  authoritativeAsOf: string | null;
}

export interface PreparedOutreachV3Context {
  /** Writing guidance only. Factual V3 context always uses serverEvidence. */
  selectedItems: SelectedContextItemRef[];
  serverEvidence: OutreachV3ServerEvidence[];
  sourceContextKeys: string[];
}

/**
 * Convert CURRENT server-reauthorized V3 references into inputs understood by
 * the existing governed Evidence Packet machinery.
 *
 * No browser display text is accepted here. `current` must come from
 * OutreachContextReferenceService.resolveOne() immediately before generation.
 *
 * Every factual V3 source is captured once as bounded server evidence. The
 * gateway request compiler uses this same captured string both as the packet
 * enrichment loader result and the Phase 0 audit ledger serialization. That
 * makes the writer, deterministic verifier and auditor consume identical
 * factual text without changing Classic's shared GenerationGatewayService.
 */
export function prepareOutreachV3ContextForGeneration(
  selected: readonly OutreachResolvedContextRefV1[],
  current: readonly OutreachResolvedContextRefV1[],
): PreparedOutreachV3Context {
  const selectedByKey = new Map(selected.map((entry) => [entry.contextKey, entry]));
  const currentByKey = new Map(current.map((entry) => [entry.contextKey, entry]));
  const selectedItems: SelectedContextItemRef[] = [];
  const serverEvidence: OutreachV3ServerEvidence[] = [];
  const sourceContextKeys: string[] = [];

  for (const contextKey of [...selectedByKey.keys()].sort(compareStrings)) {
    const chosen = selectedByKey.get(contextKey)!;
    const fresh = currentByKey.get(contextKey);
    if (!fresh || fresh.snapshotHash !== chosen.snapshotHash) {
      throw new OutreachV3GenerationContextError(
        'CONTEXT_SNAPSHOT_CHANGED',
        'Selected campaign context changed after review. Review the updated source before generating.',
        contextKey,
      );
    }

    sourceContextKeys.push(contextKey);

    if (fresh.contextClass === 'writing_guidance') {
      if (!fresh.usableAsWritingGuidance) {
        throw new OutreachV3GenerationContextError(
          'WRITING_GUIDANCE_NOT_ALLOWED',
          'A selected writing-guidance source is no longer authorized as guidance.',
          contextKey,
        );
      }
      // The CURRENT server-rehydrated guidance goes through the mature
      // authenticated DIRECTIVE path and can never be cited as factual evidence.
      selectedItems.push({
        id: `v3-guidance:${contextKey}`,
        kind: 'note',
        scope: 'all',
        customNoteText: fresh.summary,
        noteUse: 'instruction',
      });
      continue;
    }

    const userSuppliedTargetFact =
      fresh.contextClass === 'target_specific' && fresh.verificationClass === 'user_supplied';
    if (!fresh.usableAsEvidence && !userSuppliedTargetFact) {
      throw new OutreachV3GenerationContextError(
        'CONTEXT_NOT_USABLE_AS_EVIDENCE',
        'A selected factual source is no longer authorized as evidence.',
        contextKey,
      );
    }

    const bounded = boundEvidenceText(fresh.summary);
    serverEvidence.push({
      contextKey,
      sourceType: sourceTypeFor(fresh),
      sourceId: contextKey,
      title: fresh.title,
      text: bounded.text,
      truncated: bounded.truncated,
      trust: trustFor(fresh),
      clientId: fresh.clientId,
      authoritativeAsOf: fresh.sourceSnapshot.lastVerifiedAt,
    });
  }

  return {
    selectedItems,
    serverEvidence,
    sourceContextKeys,
  };
}

function sourceTypeFor(ref: OutreachResolvedContextRefV1): string {
  if (ref.locator.source === 'government_record') {
    return `outreach_v3:government_record:${ref.locator.category}`;
  }
  return `outreach_v3:${ref.locator.source}`;
}

function trustFor(ref: OutreachResolvedContextRefV1): EvidenceTrust {
  switch (ref.verificationClass) {
    case 'authoritative':
      return 'authoritative_structured';
    case 'first_party':
    case 'derived':
      return 'server_record';
    case 'user_supplied':
      return 'user_authored';
    case 'unverified':
      return 'external_untrusted';
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
