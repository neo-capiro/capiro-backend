import { createHash } from 'node:crypto';
import type {
  PublicHearingContext,
  PublicHearingInsight,
  TenantHearingClientContext,
  TenantHearingRelevance,
  TenantHearingRelevanceContext,
} from './public-hearing-intelligence.types.js';

export interface TenantHearingRelevanceProcessorOptions {
  minimumScore?: number;
  now?: () => Date;
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function idValue(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Public extraction has no Congress number available at segment time and emits
 * `HR-1234`; the canonical tracker key is `119-hr-1234`. The measure identity
 * inside one hearing's current-Congress context is the type+number suffix, so
 * strip only an explicit numeric Congress prefix immediately before a supported
 * bill/resolution type. Ordinary numbers inside the bill number are untouched.
 */
function billIdValue(value: string): string {
  return idValue(value).replace(
    /^\d{2,3}(?=(?:HR|S|HJRES|SJRES|HCONRES|SCONRES|HRES|SRES)\d+$)/,
    '',
  );
}

function stableId(tenantId: string, clientId: string, insightId: string): string {
  return `thr_${createHash('sha256')
    .update(`${tenantId}\u001f${clientId}\u001f${insightId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function compactUnique<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function entityValues(insight: PublicHearingInsight, type: string): string[] {
  return (insight.entities ?? [])
    .filter((entity) => entity.entityType === type)
    .flatMap((entity) => [entity.canonicalId, entity.label])
    .filter((value): value is string => Boolean(value));
}

function scoreClient(input: {
  insight: PublicHearingInsight;
  context: PublicHearingContext;
  client: TenantHearingClientContext;
}): {
  score: number;
  matchedOn: TenantHearingRelevance['matchedOn'];
} {
  const matchedOn: TenantHearingRelevance['matchedOn'] = [];
  let score = 0;
  const haystack = normalized(
    [
      input.insight.title,
      input.insight.summary,
      input.insight.evidenceText ?? '',
      ...(input.insight.entities ?? []).map((entity) => entity.label),
    ].join(' '),
  );

  const state = Boolean(
    input.context.geographicJurisdiction && input.context.geographicJurisdiction !== 'US',
  );
  const billValues = new Set(
    state
      ? (input.insight.entities ?? [])
          .filter((entity) => entity.entityType === 'BILL' && entity.canonicalId)
          .map((entity) => entity.canonicalId!)
      : entityValues(input.insight, 'BILL').map(billIdValue),
  );
  for (const billId of input.client.billIds) {
    if (billValues.has(state ? billId : billIdValue(billId))) {
      score += 45;
      matchedOn.push({ kind: 'BILL', value: billId });
    }
  }

  const peValues = new Set(entityValues(input.insight, 'PROGRAM_ELEMENT').map(idValue));
  for (const peCode of input.client.programElementIds) {
    if (peValues.has(idValue(peCode))) {
      score += 45;
      matchedOn.push({ kind: 'PROGRAM_ELEMENT', value: peCode });
    }
  }

  const agencyValues = entityValues(input.insight, 'AGENCY').map(normalized);
  for (const agency of input.client.agencies) {
    const candidate = normalized(agency);
    if (
      candidate &&
      (agencyValues.some(
        (value) => value === candidate || value.includes(candidate) || candidate.includes(value),
      ) ||
        haystack.includes(candidate))
    ) {
      score += 30;
      matchedOn.push({ kind: 'AGENCY', value: agency });
    }
  }

  const hearingCommittee = normalized(
    [
      input.context.committeeId ?? '',
      input.context.committeeName ?? '',
      input.context.subcommitteeId ?? '',
      input.context.subcommitteeName ?? '',
    ].join(' '),
  );
  for (const committee of input.client.committees) {
    const candidate = normalized(committee);
    if (candidate && hearingCommittee.includes(candidate)) {
      score += 25;
      matchedOn.push({ kind: 'COMMITTEE', value: committee });
    }
  }

  let keywordScore = 0;
  for (const keyword of input.client.keywords) {
    const candidate = normalized(keyword);
    if (!candidate || candidate.length < 2 || !haystack.includes(candidate)) continue;
    keywordScore += candidate.includes(' ') ? 15 : 10;
    matchedOn.push({ kind: 'KEYWORD', value: keyword });
  }
  score += Math.min(40, keywordScore);

  return {
    score: Math.min(100, score),
    matchedOn: compactUnique(matchedOn, (match) => `${match.kind}:${normalized(match.value)}`),
  };
}

/**
 * Tenant relevance runs only after global public insights exist. It never writes
 * back into those insights and is deliberately housed in a separate processor so
 * client/watchlist data cannot leak into the public transcript or insight rail.
 */
export class TenantHearingRelevanceProcessor {
  private readonly minimumScore: number;
  private readonly now: () => Date;

  constructor(options: TenantHearingRelevanceProcessorOptions = {}) {
    this.minimumScore = Math.max(0, Math.min(100, options.minimumScore ?? 20));
    this.now = options.now ?? (() => new Date());
  }

  score(input: {
    insights: readonly PublicHearingInsight[];
    context: PublicHearingContext;
    tenantContext: TenantHearingRelevanceContext;
  }): TenantHearingRelevance[] {
    const createdAt = this.now().toISOString();
    const output: TenantHearingRelevance[] = [];
    for (const insight of input.insights) {
      if (insight.hearingId !== input.context.hearingId) {
        throw new Error(
          `Public insight ${insight.id} belongs to ${insight.hearingId}, not ${input.context.hearingId}`,
        );
      }
      for (const client of input.tenantContext.clients) {
        const result = scoreClient({
          insight,
          context: input.context,
          client,
        });
        if (result.score < this.minimumScore) continue;
        output.push({
          id: stableId(input.tenantContext.tenantId, client.clientId, insight.id),
          tenantId: input.tenantContext.tenantId,
          clientId: client.clientId,
          clientName: client.clientName,
          hearingId: input.context.hearingId,
          insightId: insight.id,
          score: result.score,
          matchedOn: result.matchedOn,
          rationale: result.matchedOn.length
            ? `Matched ${result.matchedOn
                .map((match) => `${match.kind.toLowerCase()}: ${match.value}`)
                .join('; ')}.`
            : 'Matched the tenant relevance threshold.',
          createdAt,
        });
      }
    }
    return output.sort(
      (left, right) =>
        right.score - left.score ||
        left.clientId.localeCompare(right.clientId) ||
        left.insightId.localeCompare(right.insightId),
    );
  }
}
