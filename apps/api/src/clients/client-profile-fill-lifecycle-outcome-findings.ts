import type { TenantContext } from '@capiro/shared';
import type { CompletionFindingInput } from './client-profile-fill-completion-persistence.js';
import { asString } from './client-profile-fill.helpers.js';
import {
  buildAppropriationsOutcomeFinding,
  matchCommunityFundingAppropriationsDeterministically,
  type AppropriationsOutcomeMatch,
} from './community-funding-appropriations-outcome.js';
import {
  matchAdvocacyOutcomeDeterministically,
  scoreAdvocacyOutcome,
} from './client-profile-fill-advocacy-mapping.js';

export interface LifecycleOutcome {
  id: string;
  kind: string;
  sourceType: string;
  sourceId: string | null;
  evidence: unknown;
  notes: string | null;
  observedAt: Date;
}
export interface LifecycleMatterIdentifier {
  id: string;
  primaryPeCode: string | null;
  primaryBillId: string | null;
}
export interface LifecycleOutcomesPorts {
  persistFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
  ): Promise<boolean>;
  recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ): Promise<void>;
}

export class ClientProfileFillLifecycleOutcomeFindings {
  constructor(private readonly ports: LifecycleOutcomesPorts) {}

  matchCommunityFunding(
    record: Record<string, unknown>,
    externalKey: string,
    metadata: Record<string, unknown>,
    outcome: LifecycleOutcome,
    evidence: Record<string, unknown>,
    activityDate: Date | null,
  ) {
    return matchCommunityFundingAppropriationsDeterministically(
      {
        externalKey,
        recordType: asString(record.recordType),
        sourceType: asString(record.sourceType),
        sourceId: asString(record.sourceId),
        communityFundingRequestId:
          asString(metadata.communityFundingRequestId) ?? asString(record.sourceId),
        appropriationsAccountRaw:
          asString(metadata.appropriationsAccountRaw) ??
          asString(metadata.appropriations_account_raw),
        appropriationsAccountNormalized: asString(metadata.appropriationsAccountNormalized),
        fiscalYear:
          typeof metadata.fiscalYear === 'number'
            ? metadata.fiscalYear
            : Number(asString(metadata.fiscalYear) ?? NaN) || null,
      },
      {
        communityFundingRequestId: asString(evidence.communityFundingRequestId),
        appropriationsAccountRaw:
          asString(evidence.appropriationsAccountRaw) ??
          asString(evidence.appropriations_account_raw) ??
          asString(evidence.account),
        appropriationsAccountNormalized: asString(evidence.appropriationsAccountNormalized),
        fiscalYear:
          typeof evidence.fiscalYear === 'number' || typeof evidence.fiscalYear === 'string'
            ? evidence.fiscalYear
            : typeof evidence.fy === 'number' || typeof evidence.fy === 'string'
              ? evidence.fy
              : (asString(evidence.fiscalYear) ?? asString(evidence.fy)),
        amountStage: asString(evidence.amountStage) ?? asString(evidence.stage),
        amountFrom:
          typeof evidence.amountFrom === 'number' || typeof evidence.amountFrom === 'string'
            ? evidence.amountFrom
            : asString(evidence.amountFrom),
        amountTo:
          typeof evidence.amountTo === 'number' || typeof evidence.amountTo === 'string'
            ? evidence.amountTo
            : asString(evidence.amountTo),
        notes: outcome.notes,
      },
      {
        attributableActivityDate: activityDate,
        outcomeObservedAt: outcome.observedAt,
      },
    );
  }

  emitCommunityFunding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    externalKey: string,
    matterId: string | null,
    outcome: LifecycleOutcome,
    evidence: Record<string, unknown>,
    cpfMatch: AppropriationsOutcomeMatch,
  ): Promise<boolean> {
    const proposedValue = buildAppropriationsOutcomeFinding({
      matterId,
      advocacyExternalKey: externalKey,
      communityFundingRequestId: cpfMatch.communityFundingRequestId,
      outcome: {
        id: outcome.id,
        kind: outcome.kind,
        sourceType: outcome.sourceType,
        sourceId: outcome.sourceId,
        observedAt: outcome.observedAt.toISOString(),
        notes: outcome.notes,
        evidence: evidence as never,
      },
      match: cpfMatch,
    });
    return this.ports.persistFinding(ctx.tenantId, clientId, runId, {
      kind: 'advocacy_outcome',
      targetKey: `advocacy-outcome:${externalKey}:${outcome.id}`,
      source: 'lifecycle_outcomes',
      factKind: 'recommendation',
      currentValue: null,
      proposedValue,
      confidence: cpfMatch.score,
      status: 'pending',
      evidence: [
        {
          label:
            cpfMatch.matchedOn === 'community_funding_request_id'
              ? `Later appropriations/funding evidence cites this exact canonical CPF/CDS request (identifier alignment only — not proof funding was secured)`
              : `Later appropriations/funding evidence matches this CPF/CDS request on exact account + FY (identifier alignment only — not proof funding was secured)`,
          source: 'Capiro Outcome Event',
          metadata: {
            outcomeEventId: outcome.id,
            observedAt: outcome.observedAt.toISOString(),
            causationClaimed: false,
            matchedOn: cpfMatch.matchedOn,
            communityFundingRequestId: cpfMatch.communityFundingRequestId,
            appropriationsAccountKey: cpfMatch.accountKey,
            fiscalYear: cpfMatch.fiscalYear,
          },
        },
      ],
    });
  }

  matchGeneric(
    record: Record<string, unknown>,
    matterIdentifier: LifecycleMatterIdentifier | undefined,
    outcome: LifecycleOutcome,
    evidence: Record<string, unknown>,
  ) {
    const deterministic = matchAdvocacyOutcomeDeterministically(matterIdentifier, evidence);
    const score = deterministic
      ? Math.max(0.9, deterministic.score)
      : scoreAdvocacyOutcome(record, {
          kind: outcome.kind,
          sourceType: outcome.sourceType,
          sourceId: outcome.sourceId,
          notes: outcome.notes,
          evidence: outcome.evidence,
        });
    return { deterministic, score };
  }

  emitGeneric(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    externalKey: string,
    outcome: LifecycleOutcome,
    deterministic: ReturnType<typeof matchAdvocacyOutcomeDeterministically>,
    score: number,
  ): Promise<boolean> {
    // §17 causality contract vocabulary — never a fabricated label. A
    // deterministic PE/bill match is materially stronger evidence than
    // pure semantic overlap, but it is still NOT the same as an
    // explicit source relationship or a human confirmation (§16 steps
    // 5-6) — "strongly_aligned" is the honest word for it, not
    // "confirmed_relationship".
    const relationship: 'strongly_aligned' | 'related' | 'observed_after_advocacy' = deterministic
      ? 'strongly_aligned'
      : score >= 0.6
        ? 'related'
        : 'observed_after_advocacy';
    const proposedValue = {
      advocacyExternalKey: externalKey,
      outcomeEventId: outcome.id,
      outcomeKind: outcome.kind,
      observedAt: outcome.observedAt.toISOString(),
      notes: outcome.notes,
      evidence: outcome.evidence,
      relationship,
      matchedOn: deterministic?.matchedOn ?? 'semantic_and_temporal',
      causationClaimed: false,
      score,
    };
    return this.ports.persistFinding(ctx.tenantId, clientId, runId, {
      kind: 'advocacy_outcome',
      targetKey: `advocacy-outcome:${externalKey}:${outcome.id}`,
      source: 'lifecycle_outcomes',
      factKind: 'recommendation',
      currentValue: null,
      proposedValue,
      confidence: score,
      status: 'pending',
      evidence: [
        {
          label: deterministic
            ? `Observed outcome "${outcome.kind}" matches this Matter's ${deterministic.matchedOn === 'pe_code' ? 'Program Element' : 'bill'} exactly`
            : `Observed outcome "${outcome.kind}" followed a related advocacy record`,
          source: 'Capiro Outcome Event',
          metadata: {
            outcomeEventId: outcome.id,
            observedAt: outcome.observedAt.toISOString(),
            causationClaimed: false,
            matchedOn: deterministic?.matchedOn ?? 'semantic_and_temporal',
          },
        },
      ],
    });
  }
}
