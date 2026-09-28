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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function evidenceFromResult(result: StatusToolResult): CertificationStatusEvidence | null {
  const record = result.record;
  if (
    result.found === true
    && result.ambiguous === false
    && nonEmptyString(record?.productId)
    && nonEmptyString(record.status)
    && nonEmptyString(record.sourceUrl)
    && nonEmptyString(record.observedAt)
  ) {
    return {
      entityId: record.productId,
      entityNames: [record.cspName, record.csoName]
        .filter(nonEmptyString),
      status: record.status,
      impactLevel: nonEmptyString(record.impactLevel) ? record.impactLevel : undefined,
      sourceUrl: record.sourceUrl,
      observedAt: record.observedAt,
      authoritative: true,
      primary: true,
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

/**
 * Enforce from already-retained authoritative results only. This path performs
 * no lookup and is safe after aggregate acquisition has stopped. Claims without
 * retained support are localized as unverified rather than released unchanged.
 */
export function enforceRetainedStatusProvenance(input: {
  reply: string;
  retainedResults: readonly unknown[];
}): StatusProvenanceRuntimeResult {
  const startedAt = Date.now();
  const claims = detectFedrampStatusClaims(input.reply);
  const outcomes: Record<StatusCheckOutcome, number> = {
    exact: 0,
    paraphrased: 0,
    mismatch: 0,
    unsupported: 0,
    negative_unsupported: 0,
  };
  const evidence = input.retainedResults.flatMap((result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const item = evidenceFromResult(result as StatusToolResult);
    return item ? [item] : [];
  });
  const checked = checkFedrampStatusClaims(claims, evidence);
  for (const item of checked) outcomes[item.outcome] += 1;
  const fullySupported = checked.every(
    (item) => item.evidence !== null && item.outcome !== 'negative_unsupported',
  );
  return {
    reply: enforceFedrampStatusReply(input.reply, checked),
    outcomes,
    lookupOk: fullySupported,
    latencyMs: Date.now() - startedAt,
    detected: claims.length,
    failureReason: fullySupported ? null : 'retained_evidence_only',
  };
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
    exact: 0, paraphrased: 0, mismatch: 0, unsupported: 0, negative_unsupported: 0,
  };
  if (!claims.length) return { reply: input.reply, outcomes, lookupOk: true, latencyMs: Date.now() - startedAt, detected: 0, failureReason: null };
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
      const item = evidenceFromResult(result);
      if (item) evidence.push(item);
    }
    const checked = checkFedrampStatusClaims(claims, evidence);
    for (const item of checked) outcomes[item.outcome] += 1;
    const fullySupported = checked.every(
      (item) => item.evidence !== null && item.outcome !== 'negative_unsupported',
    );
    return {
      reply: input.mode === 'enforce' ? enforceFedrampStatusReply(input.reply, checked) : input.reply,
      outcomes,
      lookupOk: fullySupported,
      latencyMs: Date.now() - startedAt,
      detected: claims.length,
      failureReason: fullySupported ? null : 'unsupported_entity',
    };
  } catch (error) {
    return {
      reply: input.reply,
      outcomes,
      lookupOk: false,
      latencyMs: Date.now() - startedAt,
      detected: claims.length,
      failureReason: error instanceof Error && error.message === 'deadline' ? 'deadline' : 'lookup_failed',
    };
  }
}
