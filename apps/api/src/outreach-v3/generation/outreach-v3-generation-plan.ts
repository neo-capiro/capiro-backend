import { createHash } from 'node:crypto';
import type { OutreachResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import type { OutreachCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import type {
  OutreachCampaignReadiness,
  OutreachReadinessBlocker,
} from '../state/outreach-readiness.contract.js';

export const OUTREACH_V3_GENERATION_PLAN_VERSION = 'outreach_v3_generation_plan_v1' as const;
export const OUTREACH_V3_REPRESENTATIVE_SAMPLE_LIMIT = 3;

const FUTURE_PHASE_BLOCKERS = new Set<OutreachReadinessBlocker>([
  'GENERATION_NOT_AVAILABLE',
  'DRAFTS_NOT_AVAILABLE',
  'PREFLIGHT_NOT_AVAILABLE',
]);

export const OUTREACH_V3_GENERATION_BLOCKER_CODES = [
  'PENDING_PROPOSALS',
  'SHARED_THREAD_HIGH_PERSONALIZATION',
] as const;

export type OutreachV3GenerationBlockerCode =
  | OutreachReadinessBlocker
  | (typeof OUTREACH_V3_GENERATION_BLOCKER_CODES)[number];

export interface OutreachV3GenerationContextRef {
  contextKey: string;
  snapshotHash: string;
  contextClass: OutreachResolvedContextRefV1['contextClass'];
  scope: OutreachResolvedContextRefV1['scope'];
}

export interface OutreachV3GenerationRecipient {
  targetKey: string;
  displayName: string;
  email: string | null;
  title: string | null;
  organization: string | null;
  source: OutreachResolvedTargetRefV1['locator']['source'];
  sourceId: string;
  clientId: string | null;
  governmentLevel: OutreachResolvedTargetRefV1['jurisdiction']['governmentLevel'];
  chamber: string | null;
  state: string | null;
  district: string | null;
  snapshotHash: string;
}

export interface OutreachV3GenerationSlot {
  generationKey: string;
  recipientKey: string;
  audienceKind: 'individual' | 'group';
  scopeKeys: string[];
  recipients: OutreachV3GenerationRecipient[];
  context: {
    requiredPolicy: OutreachV3GenerationContextRef[];
    writingGuidance: OutreachV3GenerationContextRef[];
    campaignFacts: OutreachV3GenerationContextRef[];
    targetSpecific: OutreachV3GenerationContextRef[];
    groupSafe: OutreachV3GenerationContextRef[];
  };
  diversitySignature: string;
}

export interface OutreachV3GenerationPlan {
  planVersion: typeof OUTREACH_V3_GENERATION_PLAN_VERSION;
  planHash: string;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  eligible: boolean;
  blockers: OutreachV3GenerationBlockerCode[];
  sponsorClientId: string | null;
  deliveryPattern: OutreachCampaignSpecV1['delivery']['pattern'];
  personalization: OutreachCampaignSpecV1['delivery']['personalization'];
  slots: OutreachV3GenerationSlot[];
  representativeSampleKeys: string[];
}

export interface BuildOutreachV3GenerationPlanInput {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  spec: OutreachCampaignSpecV1;
  readiness: OutreachCampaignReadiness;
  pendingProposalCount: number;
}

/**
 * Converts the already-authorized canonical Campaign Spec into immutable-looking
 * generation slots. This function is deliberately pure: no Prisma, capability,
 * model, audit, approval, send, clock or random dependency belongs here.
 *
 * Source snapshots remain references only. The eventual generation action must
 * reauthorize and rehydrate every source before calling the governed generation
 * gateway; this plan is not evidence and is never a model input by itself.
 */
export function buildOutreachV3GenerationPlan(
  input: BuildOutreachV3GenerationPlanInput,
): OutreachV3GenerationPlan {
  const blockers: OutreachV3GenerationBlockerCode[] = planningBlockers(input.readiness);
  if (input.pendingProposalCount > 0) blockers.push('PENDING_PROPOSALS');
  if (
    input.spec.delivery.pattern === 'shared_thread' &&
    input.spec.delivery.personalization === 'high'
  ) {
    blockers.push('SHARED_THREAD_HIGH_PERSONALIZATION');
  }

  const slots = buildSlots(input.sessionId, input.spec);
  const representativeSampleKeys = selectRepresentativeSampleKeys(slots);
  const sponsorClientId =
    input.spec.sponsor.kind === 'client'
      ? (input.spec.sponsor.clientRefs[0]?.clientId ?? null)
      : null;

  const hashPayload = {
    planVersion: OUTREACH_V3_GENERATION_PLAN_VERSION,
    sessionId: input.sessionId,
    stateVersion: input.stateVersion,
    specHash: input.specHash,
    blockers: uniqueSorted(blockers),
    sponsorClientId,
    deliveryPattern: input.spec.delivery.pattern,
    personalization: input.spec.delivery.personalization,
    slots,
    representativeSampleKeys,
  };

  return {
    ...hashPayload,
    eligible: blockers.length === 0 && slots.length > 0,
    blockers: uniqueSorted(blockers),
    planHash: sha256(JSON.stringify(hashPayload)),
  };
}

/** Phase 6 planning is complete when only later-phase availability blockers remain. */
export function planningBlockers(readiness: OutreachCampaignReadiness): OutreachReadinessBlocker[] {
  return readiness.blockers.filter((code) => !FUTURE_PHASE_BLOCKERS.has(code));
}

export function selectRepresentativeSampleKeys(
  inputSlots: readonly OutreachV3GenerationSlot[],
  limit = OUTREACH_V3_REPRESENTATIVE_SAMPLE_LIMIT,
): string[] {
  if (limit <= 0) return [];
  const slots = [...inputSlots].sort(compareSlots);
  if (slots.length <= limit) return slots.map((slot) => slot.generationKey);

  const selected: OutreachV3GenerationSlot[] = [];
  const selectedKeys = new Set<string>();
  const seenSignatures = new Set<string>();

  // Prefer distinct audience shapes first so the review set is representative,
  // then fill deterministically. No model chooses its own examples.
  for (const slot of slots) {
    if (selected.length >= limit) break;
    if (seenSignatures.has(slot.diversitySignature)) continue;
    seenSignatures.add(slot.diversitySignature);
    selected.push(slot);
    selectedKeys.add(slot.generationKey);
  }
  for (const slot of slots) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(slot.generationKey)) continue;
    selected.push(slot);
    selectedKeys.add(slot.generationKey);
  }

  return selected.map((slot) => slot.generationKey);
}

function buildSlots(sessionId: string, spec: OutreachCampaignSpecV1): OutreachV3GenerationSlot[] {
  const targets = [...spec.targeting.selectedTargetRefs].sort((a, b) =>
    compareStrings(a.targetKey, b.targetKey),
  );

  if (spec.delivery.pattern === 'shared_thread') {
    if (!targets.length) return [];
    const groupKeyHash = sha256(targets.map((target) => target.targetKey).join('\n'));
    const generationKey = `v3:${sessionId}:shared:${groupKeyHash}`;
    return [
      {
        generationKey,
        recipientKey: `shared:${groupKeyHash}`,
        audienceKind: 'group',
        scopeKeys: uniqueSorted(
          targets
            .flatMap((target) => [target.targetKey, target.email?.toLowerCase() ?? ''])
            .filter(Boolean),
        ),
        recipients: targets.map(toRecipient),
        context: contextForGroup(spec),
        diversitySignature: 'group:shared_thread',
      },
    ];
  }

  return targets.map((target) => ({
    generationKey: `v3:${sessionId}:target:${target.targetKey}`,
    recipientKey: target.targetKey,
    audienceKind: 'individual' as const,
    scopeKeys: uniqueSorted(
      [target.targetKey, target.email?.toLowerCase() ?? '', target.locator.id].filter(Boolean),
    ),
    recipients: [toRecipient(target)],
    context: contextForTarget(spec, target.targetKey),
    diversitySignature: targetDiversitySignature(target),
  }));
}

function contextForTarget(
  spec: OutreachCampaignSpecV1,
  targetKey: string,
): OutreachV3GenerationSlot['context'] {
  return {
    requiredPolicy: refs(spec.context.requiredPolicyRefs),
    writingGuidance: refs(spec.context.writingGuidanceRefs),
    campaignFacts: refs(spec.context.campaignFactRefs),
    targetSpecific: refs(
      spec.context.targetSpecificRefs.filter(
        (entry) => entry.scope.kind === 'target' && entry.scope.targetKey === targetKey,
      ),
    ),
    // A group-safe fact is explicitly scoped to a group and is not silently
    // widened to an individual message.
    groupSafe: [],
  };
}

function contextForGroup(spec: OutreachCampaignSpecV1): OutreachV3GenerationSlot['context'] {
  return {
    requiredPolicy: refs(spec.context.requiredPolicyRefs),
    writingGuidance: refs(spec.context.writingGuidanceRefs),
    campaignFacts: refs(spec.context.campaignFactRefs),
    // Per-target facts cannot influence one shared-thread draft because that
    // could expose recipient-specific information to every recipient.
    targetSpecific: [],
    groupSafe: refs(spec.context.groupSafeRefs),
  };
}

function refs(entries: readonly OutreachResolvedContextRefV1[]): OutreachV3GenerationContextRef[] {
  return [...entries]
    .sort((a, b) => compareStrings(a.contextKey, b.contextKey))
    .map((entry) => ({
      contextKey: entry.contextKey,
      snapshotHash: entry.snapshotHash,
      contextClass: entry.contextClass,
      scope: entry.scope,
    }));
}

function toRecipient(target: OutreachResolvedTargetRefV1): OutreachV3GenerationRecipient {
  return {
    targetKey: target.targetKey,
    displayName: target.displayName,
    email: target.email,
    title: target.title,
    organization: target.organization,
    source: target.locator.source,
    sourceId: target.locator.id,
    clientId: target.clientId,
    governmentLevel: target.jurisdiction.governmentLevel,
    chamber: target.jurisdiction.chamber,
    state: target.jurisdiction.state,
    district: target.jurisdiction.district,
    snapshotHash: target.snapshotHash,
  };
}

function targetDiversitySignature(target: OutreachResolvedTargetRefV1): string {
  return [
    target.locator.source,
    target.jurisdiction.governmentLevel,
    target.jurisdiction.chamber ?? '-',
    target.jurisdiction.state ?? '-',
    target.clientId ?? '-',
  ].join('|');
}

function compareSlots(a: OutreachV3GenerationSlot, b: OutreachV3GenerationSlot): number {
  return compareStrings(a.generationKey, b.generationKey);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
