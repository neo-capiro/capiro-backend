import { createHash } from 'node:crypto';
import { isReasoningEffort, type ReasoningEffort } from '../../engagement/generation/reasoning-effort.js';
import type { PinnedGenerationIdentity } from '../../engagement/generation/generation-gateway.types.js';
import {
  isOutreachV3ApproachApprovalCurrent,
  remainingOutreachV3GenerationKeys,
  type OutreachV3ApproachApprovalSnapshot,
} from './outreach-v3-generation-approach.js';
import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

export const OUTREACH_V3_FULL_GENERATION_JOB_VERSION =
  'outreach_v3_full_generation_job_v1' as const;
export const OUTREACH_V3_FULL_GENERATION_BATCH_SIZE = 10;
export const OUTREACH_V3_FULL_GENERATION_MAX_ITEMS = 500;

export interface OutreachV3FullGenerationJobItem {
  generationKey: string;
}

export interface OutreachV3FullGenerationJobDescriptor {
  schemaVersion: typeof OUTREACH_V3_FULL_GENERATION_JOB_VERSION;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  approachApprovalHash: string;
  pinned: PinnedGenerationIdentity;
  items: OutreachV3FullGenerationJobItem[];
  batchSize: number;
  jobKey: string;
}

/**
 * Build the only safe durable payload for V3 async full generation.
 *
 * It intentionally contains no auth header, provider credential, recipient
 * address/text, Evidence Packet text, browser context, or mutable draft body.
 * Workers must re-load the exact Campaign Spec and reauthorize every slot from
 * its generationKey immediately before generation.
 */
export function buildOutreachV3FullGenerationJob(input: {
  plan: OutreachV3GenerationPlan;
  approachApproval: OutreachV3ApproachApprovalSnapshot | null;
  completedGenerationKeys: readonly string[];
  pinned: PinnedGenerationIdentity;
}): OutreachV3FullGenerationJobDescriptor {
  if (!input.plan.eligible) {
    throw new Error('OUTREACH_V3_FULL_GENERATION_NOT_ELIGIBLE:plan');
  }
  if (!isOutreachV3ApproachApprovalCurrent(input.plan, input.approachApproval)) {
    throw new Error('OUTREACH_V3_FULL_GENERATION_NOT_ELIGIBLE:approach_approval');
  }
  const remaining = remainingOutreachV3GenerationKeys(
    input.plan,
    input.approachApproval,
    input.completedGenerationKeys,
  );
  if (remaining.length > OUTREACH_V3_FULL_GENERATION_MAX_ITEMS) {
    throw new Error('OUTREACH_V3_FULL_GENERATION_TOO_LARGE');
  }
  const base = {
    schemaVersion: OUTREACH_V3_FULL_GENERATION_JOB_VERSION,
    sessionId: input.plan.sessionId,
    stateVersion: input.plan.stateVersion,
    specHash: input.plan.specHash,
    planHash: input.plan.planHash,
    approachApprovalHash: input.approachApproval!.approvalHash,
    pinned: input.pinned,
    items: remaining.map((generationKey) => ({ generationKey })),
    batchSize: OUTREACH_V3_FULL_GENERATION_BATCH_SIZE,
  };
  return {
    ...base,
    jobKey: sha256(JSON.stringify(base)),
  };
}

/** Strict parser for the durable JSONB job payload. Fails closed on drift/corruption. */
export function parseOutreachV3FullGenerationJob(
  value: unknown,
): OutreachV3FullGenerationJobDescriptor | null {
  const raw = asRecord(value);
  if (raw.schemaVersion !== OUTREACH_V3_FULL_GENERATION_JOB_VERSION) return null;
  if (!isString(raw.sessionId) || !isHash(raw.specHash) || !isHash(raw.planHash)) return null;
  if (
    !isHash(raw.approachApprovalHash) ||
    !Number.isInteger(raw.stateVersion) ||
    Number(raw.stateVersion) < 1
  ) {
    return null;
  }
  const pinned = asRecord(raw.pinned);
  if (
    !isString(pinned.provider) ||
    !isString(pinned.model) ||
    !(pinned.planModel === null || typeof pinned.planModel === 'string') ||
    !(
      pinned.reasoningEffort === undefined ||
      pinned.reasoningEffort === null ||
      (typeof pinned.reasoningEffort === 'string' && isReasoningEffort(pinned.reasoningEffort))
    ) ||
    !isString(pinned.promptSpecVersion)
  ) {
    return null;
  }
  // Secrets/tokens are categorically forbidden in the durable descriptor.
  for (const forbidden of [
    'apiKey',
    'authorization',
    'authHeader',
    'token',
    'accessToken',
    'refreshToken',
  ]) {
    if (forbidden in pinned || forbidden in raw) return null;
  }
  if (!Array.isArray(raw.items) || raw.items.length > OUTREACH_V3_FULL_GENERATION_MAX_ITEMS)
    return null;
  const items: OutreachV3FullGenerationJobItem[] = [];
  const seen = new Set<string>();
  for (const item of raw.items) {
    const parsed = asRecord(item);
    if (!isString(parsed.generationKey) || parsed.generationKey.length > 1024) return null;
    if (seen.has(parsed.generationKey)) return null;
    seen.add(parsed.generationKey);
    items.push({ generationKey: parsed.generationKey });
  }
  if (!Number.isInteger(raw.batchSize) || Number(raw.batchSize) < 1 || Number(raw.batchSize) > 25) {
    return null;
  }
  if (!isHash(raw.jobKey)) return null;

  const descriptor: OutreachV3FullGenerationJobDescriptor = {
    schemaVersion: OUTREACH_V3_FULL_GENERATION_JOB_VERSION,
    sessionId: raw.sessionId,
    stateVersion: Number(raw.stateVersion),
    specHash: raw.specHash,
    planHash: raw.planHash,
    approachApprovalHash: raw.approachApprovalHash,
    pinned: {
      provider: pinned.provider,
      model: pinned.model,
      planModel: pinned.planModel as string | null,
      ...(pinned.reasoningEffort !== undefined
        ? { reasoningEffort: pinned.reasoningEffort as ReasoningEffort | null }
        : {}),
      promptSpecVersion: pinned.promptSpecVersion,
      ...(typeof pinned.contextPacketId === 'string'
        ? { contextPacketId: pinned.contextPacketId }
        : {}),
    },
    items,
    batchSize: Number(raw.batchSize),
    jobKey: raw.jobKey,
  };
  const { jobKey, ...base } = descriptor;
  return sha256(JSON.stringify(base)) === jobKey ? descriptor : null;
}

export function isOutreachV3FullGenerationJobCurrent(
  job: OutreachV3FullGenerationJobDescriptor,
  plan: OutreachV3GenerationPlan,
  approval: OutreachV3ApproachApprovalSnapshot | null,
): boolean {
  if (!isOutreachV3ApproachApprovalCurrent(plan, approval)) return false;
  return (
    job.schemaVersion === OUTREACH_V3_FULL_GENERATION_JOB_VERSION &&
    job.sessionId === plan.sessionId &&
    job.stateVersion === plan.stateVersion &&
    job.specHash === plan.specHash &&
    job.planHash === plan.planHash &&
    job.approachApprovalHash === approval!.approvalHash &&
    job.items.every((item) => plan.slots.some((slot) => slot.generationKey === item.generationKey))
  );
}

/** Deterministic bounded claim ordering for one worker pass. */
export function nextOutreachV3FullGenerationBatch(
  job: OutreachV3FullGenerationJobDescriptor,
  unfinishedGenerationKeys: readonly string[],
): string[] {
  const jobKeys = new Set(job.items.map((item) => item.generationKey));
  return [...new Set(unfinishedGenerationKeys)]
    .filter((key) => jobKeys.has(key))
    .sort(compareStrings)
    .slice(0, job.batchSize);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
