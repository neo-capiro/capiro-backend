import { createHash } from 'node:crypto';
import type { EvidenceDecision, EvidenceEnvelope, EvidenceQuestion } from './decision-contract';
import { hashEvidenceEnvelope } from './decision-contract';
import { JEV_TASK_REGISTRY_VERSION } from './task-registry';
import type { JevTask } from './jev-config';

export const JEV_DECISION_CACHE_MAX_ENTRIES = 1_000;
export const JEV_DECISION_CACHE_TTL_MS = 5 * 60_000;

export interface JevDecisionCacheKeyInput {
  task: JevTask;
  tenantId: string;
  clientId: string | null;
  envelope: EvidenceEnvelope;
  claim: { id: string; text: string };
  questionVersion: string;
  question: EvidenceQuestion;
  modelVersion: string;
  cacheIdentityVersion?: string;
  candidateIdentity?: unknown;
  registryVersion?: string;
}

export type JevOutcomeDecision = Extract<EvidenceDecision, { kind: 'outcome' }>;

export interface JevCacheableOutcomeDecision {
  kind: 'outcome';
  outcome: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  cached?: boolean;
}
export interface JevCacheableFailureDecision {
  kind: 'failure';
}
export type JevCacheableDecision = JevCacheableOutcomeDecision | JevCacheableFailureDecision;

export type JevCacheMode = 'shadow' | 'enforce';
export interface JevCacheObservation {
  lookups: number;
  hits: number;
  agreements: number;
}

export function jevDecisionCacheKey(input: JevDecisionCacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        task: input.task,
        tenantId: input.tenantId,
        clientId: input.clientId,
        envelopeHash: hashEvidenceEnvelope(input.envelope),
        claim: input.claim,
        questionVersion: input.questionVersion,
        questionHash: createHash('sha256').update(JSON.stringify(input.question)).digest('hex'),
        modelVersion: input.modelVersion,
        registryVersion: input.registryVersion ?? JEV_TASK_REGISTRY_VERSION,
        cacheIdentityVersion: input.cacheIdentityVersion ?? null,
        candidateIdentity: input.candidateIdentity ?? null,
      }),
    )
    .digest('hex');
}

export class JevDecisionCache<TOutcome extends JevCacheableOutcomeDecision = JevOutcomeDecision> {
  private readonly entries = new Map<string, { decision: TOutcome; expiresAt: number }>();

  constructor(
    private readonly options: { maxEntries: number; ttlMs: number } = {
      maxEntries: JEV_DECISION_CACHE_MAX_ENTRIES,
      ttlMs: JEV_DECISION_CACHE_TTL_MS,
    },
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): TOutcome | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.decision;
  }

  set(key: string, decision: TOutcome | JevCacheableFailureDecision): void {
    if (decision.kind !== 'outcome') return;
    this.entries.delete(key);
    this.entries.set(key, { decision, expiresAt: this.now() + this.options.ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export function decisionsAgree(left: JevCacheableDecision, right: JevCacheableDecision): boolean {
  return left.kind === 'outcome' && right.kind === 'outcome' && left.outcome === right.outcome;
}

export async function assessWithJevCache<TDecision extends JevCacheableDecision>(input: {
  mode: JevCacheMode;
  cache: JevDecisionCache<Extract<TDecision, { kind: 'outcome' }>>;
  key: string;
  assess: () => Promise<TDecision>;
}): Promise<{ decision: TDecision; observation: JevCacheObservation }> {
  const observation = { lookups: 1, hits: 0, agreements: 0 };
  const cached = input.cache.get(input.key);
  if (cached) observation.hits = 1;
  if (input.mode === 'enforce' && cached) {
    const { usage: _usage, ...withoutUsage } = cached;
    return {
      decision: { ...withoutUsage, cached: true, latencyMs: 0 } as unknown as TDecision,
      observation,
    };
  }
  const fresh = await input.assess();
  if (cached && decisionsAgree(cached, fresh)) observation.agreements = 1;
  input.cache.set(
    input.key,
    fresh as Extract<TDecision, { kind: 'outcome' }> | JevCacheableFailureDecision,
  );
  return { decision: fresh, observation };
}
