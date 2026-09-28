import {
  checkFedrampStatusClaims,
  detectFedrampStatusClaims,
  enforceFedrampStatusReply,
  type CertificationStatusEvidence,
  type MeriContext,
  type StatusCheckOutcome,
  type ToolRegistry,
} from '@capiro/meriv2-core';

interface StatusToolResult {
  found?: boolean;
  ambiguous?: boolean;
  searchedEntireDataset?: boolean;
  evidenceOfAbsence?: boolean;
  sourceUrl?: string;
  observedAt?: string;
  record?: {
    productId?: string;
    cspName?: string;
    csoName?: string;
    status?: string;
    impactLevel?: string;
    sourceUrl?: string;
    observedAt?: string;
  };
}

function evidenceFromResult(
  result: StatusToolResult,
  entity: string,
): CertificationStatusEvidence | null {
  const record = result.record;
  if (
    result.found &&
    !result.ambiguous &&
    record?.productId &&
    record.status &&
    record.sourceUrl &&
    record.observedAt
  ) {
    return {
      entityId: record.productId,
      entityNames: [entity, record.cspName ?? '', record.csoName ?? ''].filter(Boolean),
      status: record.status,
      impactLevel: record.impactLevel,
      sourceUrl: record.sourceUrl,
      observedAt: record.observedAt,
      authoritative: true,
      primary: true,
    };
  }
  if (
    !result.found &&
    result.evidenceOfAbsence &&
    result.searchedEntireDataset &&
    result.sourceUrl &&
    result.observedAt
  ) {
    return {
      entityId: entity,
      entityNames: [entity],
      status: 'not found',
      sourceUrl: result.sourceUrl,
      observedAt: result.observedAt,
      authoritative: true,
      primary: true,
      coverage: {
        description: 'the complete fetched FedRAMP Marketplace dataset',
        complete: true,
        truncated: false,
        failedSources: [],
      },
    };
  }
  return null;
}

export interface StatusProvenanceRuntimeResult {
  reply: string;
  outcomes: Record<StatusCheckOutcome, number>;
  lookupOk: boolean;
  latencyMs: number;
  detected: number;
  failureReason: string | null;
}

export async function runStatusProvenance(input: {
  reply: string;
  mode: 'shadow' | 'enforce';
  registry: ToolRegistry;
  ctx: MeriContext;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<StatusProvenanceRuntimeResult> {
  const startedAt = Date.now();
  const claims = detectFedrampStatusClaims(input.reply);
  const outcomes: Record<StatusCheckOutcome, number> = {
    exact: 0,
    paraphrased: 0,
    mismatch: 0,
    unsupported: 0,
    negative_unsupported: 0,
  };
  if (!claims.length)
    return {
      reply: input.reply,
      outcomes,
      lookupOk: true,
      latencyMs: Date.now() - startedAt,
      detected: 0,
      failureReason: null,
    };
  const evidence: CertificationStatusEvidence[] = [];
  try {
    for (const claim of claims) {
      if (input.signal?.aborted || Date.now() >= input.deadlineAt) throw new Error('deadline');
      const result = await input.registry.invoke<StatusToolResult>(
        'get_certification_status',
        { program: 'fedramp', query: claim.entityMention },
        input.ctx,
        { signal: input.signal, deadlineAt: input.deadlineAt },
      );
      const item = evidenceFromResult(result, claim.entityMention);
      if (item) evidence.push(item);
    }
    const checked = checkFedrampStatusClaims(claims, evidence);
    for (const item of checked) outcomes[item.outcome] += 1;
    return {
      reply:
        input.mode === 'enforce' ? enforceFedrampStatusReply(input.reply, checked) : input.reply,
      outcomes,
      lookupOk: true,
      latencyMs: Date.now() - startedAt,
      detected: claims.length,
      failureReason: null,
    };
  } catch (error) {
    return {
      reply: input.reply,
      outcomes,
      lookupOk: false,
      latencyMs: Date.now() - startedAt,
      detected: claims.length,
      failureReason:
        error instanceof Error && error.message === 'deadline' ? 'deadline' : 'lookup_failed',
    };
  }
}
