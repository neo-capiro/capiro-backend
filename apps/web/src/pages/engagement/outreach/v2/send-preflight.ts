// Phase 2 §3.h1 — send preflight. Composes the existing per-concern checks
// (draft sendability from versioned-drafts.ts, attachment size from
// send-intent.ts, recipient collisions from RecipientCollisions.ts) into one
// blockers/warnings list, plus the mandatory final-review acknowledgement.
// No real Send may proceed while any BLOCKER is present — see canSend.

import { attachmentPreflight } from './send-intent.js';
import { draftBlockReason, isDraftSendable, DRAFT_BLOCK_COPY } from './versioned-drafts.js';
import { analyzeRecipientCollisions } from './targets.js';
import { collisionsResolved, type CollisionResolution } from './RecipientCollisions.js';
import type { OutreachTarget } from './targets.js';
import type { WizardV2State } from './types.js';

export type PreflightCategory =
  | 'verification'
  | 'recipients'
  | 'mailbox'
  | 'attachments'
  | 'context'
  | 'idempotency';

export interface PreflightIssue {
  category: PreflightCategory;
  /** A blocker disables Send outright; a warning is shown but does not. */
  severity: 'blocker' | 'warning';
  message: string;
}

export interface SendPreflightInput {
  targets: OutreachTarget[];
  slots: Array<{ genKey: string; resultId: string }>;
  generated: WizardV2State['generatedEmails'];
  attachmentIds: string[];
  docs: Array<{ id: string; fileName: string; byteSize?: number | null }>;
  collisionResolution: CollisionResolution;
  emailConnected: boolean;
  selectedInboxId: string | null | undefined;
  /** The plan's required final checkbox: "I reviewed the recipients, current
   *  draft versions, attachments, and verification status." */
  reviewAcknowledged: boolean;
  /** True once a real send request is in flight — re-submitting mid-flight
   *  is exactly the double-Send bug the durable request key exists to close;
   *  preflight blocks it too so the button visibly reflects why it's disabled. */
  sendInFlight?: boolean;
}

export interface SendPreflightResult {
  issues: PreflightIssue[];
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  /** No real Send while false. */
  canSend: boolean;
  sendableCount: number;
  blockedGenKeys: string[];
}

export function computeSendPreflight(input: SendPreflightInput): SendPreflightResult {
  const issues: PreflightIssue[] = [];

  // ── mailbox ──────────────────────────────────────────────────────────────
  if (!input.emailConnected) {
    issues.push({
      category: 'mailbox',
      severity: 'blocker',
      message: 'No email account connected. Connect Outlook or Gmail in Settings → Integrations.',
    });
  } else if (!input.selectedInboxId) {
    issues.push({ category: 'mailbox', severity: 'blocker', message: 'Choose a sender inbox.' });
  }

  // ── recipients / collisions ──────────────────────────────────────────────
  const collisions = analyzeRecipientCollisions(input.targets);
  if (collisions.length > 0 && !collisionsResolved(input.targets, input.collisionResolution)) {
    issues.push({
      category: 'recipients',
      severity: 'blocker',
      message: `${collisions.length} recipient collision${collisions.length === 1 ? '' : 's'} need${
        collisions.length === 1 ? 's' : ''
      } an explicit resolution before sending.`,
    });
  }

  // ── attachments ──────────────────────────────────────────────────────────
  for (const a of attachmentPreflight(input.attachmentIds, input.docs)) {
    issues.push({
      category: 'attachments',
      severity: 'blocker',
      message: `"${a.fileName}" is too large to send inline (${(a.byteSize / (1024 * 1024)).toFixed(1)} MB).`,
    });
  }

  // ── verification (per-slot draft sendability) ───────────────────────────
  let sendableCount = 0;
  const blockedGenKeys: string[] = [];
  const blockReasonCounts = new Map<string, number>();
  for (const slot of input.slots) {
    const draft = input.generated[slot.genKey];
    if (isDraftSendable(draft)) {
      sendableCount++;
      continue;
    }
    blockedGenKeys.push(slot.genKey);
    const reason = draftBlockReason(draft);
    if (reason) blockReasonCounts.set(reason, (blockReasonCounts.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of blockReasonCounts) {
    // 'dirty'/'pending' are transient (autosave/verification in flight) —
    // real blockers, but distinct from a durably failed/rejected draft.
    issues.push({
      category: 'verification',
      severity: reason === 'dirty' || reason === 'pending' ? 'warning' : 'blocker',
      message: `${count} draft${count === 1 ? '' : 's'}: ${
        DRAFT_BLOCK_COPY[reason as keyof typeof DRAFT_BLOCK_COPY]
      }`,
    });
  }
  if (sendableCount === 0) {
    issues.push({
      category: 'verification',
      severity: 'blocker',
      message: 'Nothing is ready to send. Generate drafts in Generate & Review first.',
    });
  }

  // ── context / final review ──────────────────────────────────────────────
  if (!input.reviewAcknowledged) {
    issues.push({
      category: 'context',
      severity: 'blocker',
      message:
        'Confirm you reviewed the recipients, current draft versions, attachments, and verification status.',
    });
  }

  // ── idempotency ──────────────────────────────────────────────────────────
  if (input.sendInFlight) {
    issues.push({
      category: 'idempotency',
      severity: 'blocker',
      message: 'A send is already in progress for this campaign.',
    });
  }

  const blockers = issues.filter((i) => i.severity === 'blocker');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    issues,
    blockers,
    warnings,
    canSend: blockers.length === 0,
    sendableCount,
    blockedGenKeys,
  };
}
