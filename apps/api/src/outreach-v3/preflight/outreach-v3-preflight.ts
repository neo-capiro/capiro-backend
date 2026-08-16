import type {
  OutreachV3DraftApprovalSnapshot,
  OutreachV3DraftVersionIdentity,
} from '../drafts/outreach-v3-draft-lifecycle.js';
import { deriveOutreachV3DraftLifecycle } from '../drafts/outreach-v3-draft-lifecycle.js';
import type { OutreachV3GenerationPlan } from '../generation/outreach-v3-generation-plan.js';

export const OUTREACH_V3_PREFLIGHT_BLOCKER_CODES = [
  'GENERATION_PLAN_NOT_ELIGIBLE',
  'SENDER_REQUIRED',
  'SENDER_NOT_AUTHORIZED',
  'ATTACHMENT_NOT_READY',
  'EXCLUSION_NOT_IN_PLAN',
  'DRAFT_MISSING',
  'DRAFT_DUPLICATE',
  'DRAFT_NOT_EXACTLY_APPROVED',
  'DRAFT_DIRTY',
  'DRAFT_STALE',
  'DRAFT_HELD',
  'DRAFT_FAILED',
  'AUDIT_UNAVAILABLE',
  'RECIPIENT_SNAPSHOT_STALE',
  'RECIPIENT_EMAIL_MISSING',
  'RECIPIENT_EMAIL_COLLISION',
  'TEST_SEND_REQUIRES_ONE_DRAFT',
] as const;

export type OutreachV3PreflightBlockerCode = (typeof OUTREACH_V3_PREFLIGHT_BLOCKER_CODES)[number];

export interface OutreachV3PreflightDraft {
  version: OutreachV3DraftVersionIdentity;
  approval: OutreachV3DraftApprovalSnapshot | null;
  localDirty: boolean;
  recipientSnapshotCurrent: boolean;
  recipientSnapshot: Record<string, unknown>;
}

export interface OutreachV3PreflightInput {
  plan: OutreachV3GenerationPlan;
  drafts: OutreachV3PreflightDraft[];
  senderConnectionId: string | null;
  senderAuthorized: boolean;
  attachmentsReady: boolean;
  excludedGenerationKeys?: string[];
  testMode?: boolean;
}

export interface OutreachV3PreflightDraftResult {
  generationKey: string;
  versionId: string | null;
  eligible: boolean;
  blockers: OutreachV3PreflightBlockerCode[];
  recipientEmails: string[];
}

export interface OutreachV3PreflightResult {
  eligible: boolean;
  blockers: OutreachV3PreflightBlockerCode[];
  draftResults: OutreachV3PreflightDraftResult[];
  draftVersionIds: string[];
  excludedGenerationKeys: string[];
}

/**
 * Pure deterministic preflight for the V3 Send stage.
 *
 * It intentionally does not create a send intent and cannot call a provider.
 * The later action endpoint must run this on fresh server reads, then pass only
 * the returned immutable version ids into the mature OutreachSendIntentService,
 * which rechecks its own invariants inside the intent transaction.
 */
export function evaluateOutreachV3Preflight(
  input: OutreachV3PreflightInput,
): OutreachV3PreflightResult {
  const globalBlockers: OutreachV3PreflightBlockerCode[] = [];
  if (!input.plan.eligible) globalBlockers.push('GENERATION_PLAN_NOT_ELIGIBLE');
  if (!input.senderConnectionId) globalBlockers.push('SENDER_REQUIRED');
  else if (!input.senderAuthorized) globalBlockers.push('SENDER_NOT_AUTHORIZED');
  if (!input.attachmentsReady) globalBlockers.push('ATTACHMENT_NOT_READY');

  const planKeys = new Set(input.plan.slots.map((slot) => slot.generationKey));
  const excluded = uniqueSorted(input.excludedGenerationKeys ?? []);
  for (const generationKey of excluded) {
    if (!planKeys.has(generationKey)) globalBlockers.push('EXCLUSION_NOT_IN_PLAN');
  }
  const excludedSet = new Set(excluded.filter((key) => planKeys.has(key)));
  const requiredKeys = input.plan.slots
    .map((slot) => slot.generationKey)
    .filter((key) => !excludedSet.has(key))
    .sort(compareStrings);

  const byGenerationKey = new Map<string, OutreachV3PreflightDraft[]>();
  for (const draft of input.drafts) {
    const key = draft.version.generationKey;
    const entries = byGenerationKey.get(key) ?? [];
    entries.push(draft);
    byGenerationKey.set(key, entries);
  }

  const draftResults: OutreachV3PreflightDraftResult[] = [];
  for (const generationKey of requiredKeys) {
    const candidates = byGenerationKey.get(generationKey) ?? [];
    if (candidates.length === 0) {
      draftResults.push({
        generationKey,
        versionId: null,
        eligible: false,
        blockers: ['DRAFT_MISSING'],
        recipientEmails: [],
      });
      continue;
    }
    if (candidates.length !== 1) {
      draftResults.push({
        generationKey,
        versionId: null,
        eligible: false,
        blockers: ['DRAFT_DUPLICATE'],
        recipientEmails: [],
      });
      continue;
    }
    const draft = candidates[0]!;
    const blockers: OutreachV3PreflightBlockerCode[] = [];
    const lifecycle = deriveOutreachV3DraftLifecycle({
      version: draft.version,
      currentPlanHash: input.plan.planHash,
      localDirty: draft.localDirty,
      approval: draft.approval,
    });
    switch (lifecycle.state) {
      case 'approved':
        break;
      case 'dirty':
        blockers.push('DRAFT_DIRTY');
        break;
      case 'stale':
        blockers.push('DRAFT_STALE');
        break;
      case 'failed':
        blockers.push('DRAFT_FAILED');
        break;
      case 'audit_unavailable':
        blockers.push('AUDIT_UNAVAILABLE');
        break;
      case 'held':
        blockers.push('DRAFT_HELD');
        break;
      case 'ready_for_review':
        blockers.push('DRAFT_NOT_EXACTLY_APPROVED');
        break;
    }
    if (!draft.recipientSnapshotCurrent) blockers.push('RECIPIENT_SNAPSHOT_STALE');
    const recipientEmails = emailsFromRecipientSnapshot(draft.recipientSnapshot);
    const expectedCount = expectedRecipientCount(input.plan, generationKey);
    if (
      recipientEmails.length === 0 ||
      recipientEmails.length !== expectedCount ||
      recipientEmails.some((email) => !looksLikeEmail(email))
    ) {
      blockers.push('RECIPIENT_EMAIL_MISSING');
    }
    if (new Set(recipientEmails).size !== recipientEmails.length) {
      blockers.push('RECIPIENT_EMAIL_COLLISION');
    }
    draftResults.push({
      generationKey,
      versionId: draft.version.versionId,
      eligible: blockers.length === 0,
      blockers: uniqueSorted(blockers),
      recipientEmails,
    });
  }

  // Separate-message slots cannot silently collapse two logical targets onto the
  // same mailbox; that requires the user to fix or explicitly restructure the audience.
  if (input.plan.deliveryPattern !== 'shared_thread') {
    const ownerByEmail = new Map<string, string>();
    for (const result of draftResults) {
      for (const email of result.recipientEmails) {
        const normalized = email.toLowerCase();
        const owner = ownerByEmail.get(normalized);
        if (owner && owner !== result.generationKey) {
          addBlocker(result, 'RECIPIENT_EMAIL_COLLISION');
          const prior = draftResults.find((candidate) => candidate.generationKey === owner);
          if (prior) addBlocker(prior, 'RECIPIENT_EMAIL_COLLISION');
        } else {
          ownerByEmail.set(normalized, result.generationKey);
        }
      }
    }
  }

  const eligibleDrafts = draftResults.filter((result) => result.eligible);
  if (input.testMode === true && requiredKeys.length !== 1) {
    globalBlockers.push('TEST_SEND_REQUIRES_ONE_DRAFT');
  }

  const blockers = uniqueSorted([
    ...globalBlockers,
    ...draftResults.flatMap((result) => result.blockers),
  ]);
  const allRequiredEligible =
    draftResults.length === requiredKeys.length &&
    draftResults.every((result) => result.eligible && result.versionId);
  return {
    eligible: blockers.length === 0 && allRequiredEligible,
    blockers,
    draftResults,
    draftVersionIds: eligibleDrafts
      .map((result) => result.versionId)
      .filter((value): value is string => Boolean(value)),
    excludedGenerationKeys: excludedSet.size ? [...excludedSet].sort(compareStrings) : [],
  };
}

function expectedRecipientCount(plan: OutreachV3GenerationPlan, generationKey: string): number {
  const slot = plan.slots.find((candidate) => candidate.generationKey === generationKey);
  if (!slot) return 0;
  return slot.audienceKind === 'group' ? slot.recipients.length : 1;
}

export function emailsFromRecipientSnapshot(snapshot: Record<string, unknown>): string[] {
  const members = Array.isArray(snapshot.groupMembers) ? snapshot.groupMembers : [];
  if (members.length) {
    return members
      .map((entry) => {
        const value = (entry ?? {}) as Record<string, unknown>;
        return String(value.email ?? '')
          .trim()
          .toLowerCase();
      })
      .filter(Boolean);
  }
  const email = String(snapshot.email ?? '')
    .trim()
    .toLowerCase();
  return email ? [email] : [];
}

function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  return at > 0 && at < value.length - 1 && value.indexOf(' ', 0) === -1;
}

function addBlocker(
  result: OutreachV3PreflightDraftResult,
  blocker: OutreachV3PreflightBlockerCode,
): void {
  if (!result.blockers.includes(blocker)) result.blockers.push(blocker);
  result.blockers.sort(compareStrings);
  result.eligible = false;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}
