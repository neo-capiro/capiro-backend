import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * P0-3 (deep-audit critical finding): "Approval may authorize metadata rather
 * than the exact generated payload."
 *
 * A reviewer used to approve on the strength of a title, target and action
 * label. The content behind it could then change — through regeneration,
 * fallback generation, a context refresh, a model retry, target re-resolution, a
 * template change or a user edit — and nothing tied the approval to the bytes
 * that were actually reviewed.
 *
 * This module is the binding. PURE (no Nest/Prisma) so every rule is directly
 * unit-testable. It does three things:
 *
 *  1. Defines the FULL set of fields an approval binds to (the audit's list:
 *     strategy + version, node, run, exact recipients, channel, subject, full
 *     body, attachments, template version, context-pack fingerprint, grounding
 *     status, model/provider, and the send-enabled policy in force).
 *  2. Reduces that to a stable content hash.
 *  3. Verifies a stored approval against the CURRENT payload and reports
 *     precisely WHICH fields moved — so the user is told "the body and the
 *     recipient changed", never "hash mismatch".
 *
 * ---- Why the body is hashed VERBATIM ----------------------------------------
 * send-approval.ts's computeSendToken whitespace-normalizes its free text. This
 * module deliberately does NOT normalize `subject` or `body`. The audit's
 * acceptance criterion is "editing one character invalidates approval", and a
 * whitespace-collapsing hash would silently tolerate edits that change what a
 * recipient reads. Over-invalidating is the safe direction: a spurious
 * re-approval costs a click, a missed invalidation authorises content nobody
 * approved. Recipients ARE order-insensitive, because ordering carries no
 * meaning while identity does.
 *
 * ---- SAFETY BOUNDARY --------------------------------------------------------
 * Nothing here sends, and nothing here authorises a send. An approval is a
 * RECORD. The external send stays hard-disabled behind
 * STRATEGY_EXECUTION_SEND_ENABLED (see send-approval.ts); `sendEnabled` is bound
 * into the hash precisely so an approval granted while sending was disabled
 * cannot silently carry over to a world where it is enabled.
 */

/** What the approval authorises: staging an artifact, or sending externally. */
export const APPROVAL_ACTIONS = ['stage', 'send'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** One resolved recipient. Identity AND display name are both bound. */
export interface ApprovalRecipient {
  /** clientTargetId / memberId — the stable reference, when one resolved. */
  id: string | null;
  name: string;
  /** The channel address a send would use, when known. */
  address: string | null;
}

/**
 * Every field an approval binds to. Adding a field here automatically makes it
 * approval-invalidating — that is the point of keeping this one flat interface.
 */
export interface ApprovalBinding {
  // ---- identity ----
  strategyId: string;
  /** The plan head the payload was built against. Drift here invalidates. */
  strategyVersionId: string | null;
  nodeId: string;
  runId: string;
  // ---- what is being authorised ----
  action: ApprovalAction;
  /** workspace_draft | outreach_record — the channel the payload rides. */
  channel: string;
  subject: string;
  /** The full body, hashed verbatim. */
  body: string;
  recipients: ApprovalRecipient[];
  attachments: string[];
  // ---- provenance of the content ----
  templateVersion: string | null;
  /** Fingerprint of the context pack + steward health used to generate. */
  contextPackFingerprint: string | null;
  /** ok | degraded | conflicted — the grounding health at generation time. */
  groundingStatus: string | null;
  /** FALSE means this is deterministic fallback content, not grounded prose. */
  grounded: boolean;
  model: string | null;
  provider: string | null;
  // ---- policy in force at approval time ----
  sendEnabled: boolean;
}

/** A recorded approval, as persisted on run.findings.approval. */
export interface ApprovalRecord {
  contentHash: string;
  /**
   * The FULL canonical binding, stored verbatim — not just its hash. This is
   * what satisfies the audit's "the audit record can reproduce the exact
   * approved payload"; a hash alone proves a match but reproduces nothing.
   */
  binding: ApprovalBinding;
  approvedByUserId: string;
  approvedAt: string;
  status: 'approved' | 'invalidated';
  invalidatedAt?: string | null;
  invalidatedReason?: string | null;
  /** Which bound fields moved (present when status is 'invalidated'). */
  changedFields?: string[] | null;
}

export interface ApprovalVerification {
  valid: boolean;
  /** User-facing explanation. Absent when valid. */
  reason?: string;
  /** The bound fields that differ, in a stable order. */
  changedFields: string[];
}

/** Human labels for the bound fields, for the invalidation message. */
const FIELD_LABELS: Record<string, string> = {
  strategyId: 'strategy',
  strategyVersionId: 'plan version',
  nodeId: 'plan step',
  runId: 'run',
  action: 'action',
  channel: 'channel',
  subject: 'subject',
  body: 'content',
  recipients: 'recipients',
  attachments: 'attachments',
  templateVersion: 'template version',
  contextPackFingerprint: 'context pack',
  groundingStatus: 'grounding status',
  grounded: 'grounded/fallback state',
  model: 'model',
  provider: 'provider',
  sendEnabled: 'send policy',
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical recipient list: each entry reduced to a stable string, then
 * de-duplicated and sorted. Order-insensitive by design; identity-sensitive.
 */
function canonicalRecipients(recipients: readonly ApprovalRecipient[]): string[] {
  return [
    ...new Set(
      (recipients ?? []).map((r) =>
        JSON.stringify({
          address: r.address ? normalizeWhitespace(r.address).toLowerCase() : null,
          id: r.id ?? null,
          name: normalizeWhitespace(r.name ?? ''),
        }),
      ),
    ),
  ].sort();
}

function canonicalAttachments(attachments: readonly string[]): string[] {
  return [...new Set((attachments ?? []).map((a) => normalizeWhitespace(String(a))))]
    .filter((a) => a.length > 0)
    .sort();
}

/**
 * The canonical serialization the hash is taken over. Keys are written in a
 * fixed alphabetical order so the JSON string is stable across engines.
 *
 * `subject` and `body` are passed through VERBATIM — see the module header.
 */
export function canonicalizeApproval(binding: ApprovalBinding): string {
  return JSON.stringify({
    action: binding.action,
    attachments: canonicalAttachments(binding.attachments),
    body: binding.body ?? '',
    channel: binding.channel ?? '',
    contextPackFingerprint: binding.contextPackFingerprint ?? null,
    grounded: !!binding.grounded,
    groundingStatus: binding.groundingStatus ?? null,
    model: binding.model ?? null,
    nodeId: binding.nodeId,
    provider: binding.provider ?? null,
    recipients: canonicalRecipients(binding.recipients),
    runId: binding.runId,
    sendEnabled: !!binding.sendEnabled,
    strategyId: binding.strategyId,
    strategyVersionId: binding.strategyVersionId ?? null,
    subject: binding.subject ?? '',
    templateVersion: binding.templateVersion ?? null,
  });
}

/** sha256 hex over the canonical binding — the approval's content hash. */
export function computeApprovalHash(binding: ApprovalBinding): string {
  return createHash('sha256').update(canonicalizeApproval(binding), 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** The bound fields whose values differ between two bindings, in a stable order. */
export function diffBindings(a: ApprovalBinding, b: ApprovalBinding): string[] {
  const changed: string[] = [];
  const scalar: Array<keyof ApprovalBinding> = [
    'strategyId',
    'strategyVersionId',
    'nodeId',
    'runId',
    'action',
    'channel',
    'subject',
    'body',
    'templateVersion',
    'contextPackFingerprint',
    'groundingStatus',
    'model',
    'provider',
  ];
  for (const f of scalar) {
    if ((a[f] ?? null) !== (b[f] ?? null)) changed.push(f as string);
  }
  if (!!a.grounded !== !!b.grounded) changed.push('grounded');
  if (!!a.sendEnabled !== !!b.sendEnabled) changed.push('sendEnabled');
  if (canonicalRecipients(a.recipients).join('|') !== canonicalRecipients(b.recipients).join('|')) {
    changed.push('recipients');
  }
  if (
    canonicalAttachments(a.attachments).join('|') !== canonicalAttachments(b.attachments).join('|')
  ) {
    changed.push('attachments');
  }
  return changed;
}

/** "the content and the recipients changed" — for the invalidation reason. */
export function describeChangedFields(fields: readonly string[]): string {
  const labels = fields.map((f) => FIELD_LABELS[f] ?? f);
  if (labels.length === 0) return 'nothing';
  if (labels.length === 1) return `the ${labels[0]}`;
  return `the ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Verify a stored approval against the CURRENT payload.
 *
 * Fails when:
 *  - the approval was already marked invalidated;
 *  - it was minted for a DIFFERENT run (no standing approval satisfies a run);
 *  - any bound field moved;
 *  - the hash disagrees (the authoritative check — belt to the field diff's
 *    braces, so a field this module forgot to diff still cannot slip through).
 */
export function verifyApproval(
  current: ApprovalBinding,
  approval: ApprovalRecord | null | undefined,
): ApprovalVerification {
  if (!approval) {
    return { valid: false, reason: 'no approval on record for this run', changedFields: [] };
  }
  if (approval.status === 'invalidated') {
    return {
      valid: false,
      reason: approval.invalidatedReason || 'the approval was invalidated',
      changedFields: approval.changedFields ?? [],
    };
  }
  if (approval.binding.runId !== current.runId) {
    return {
      valid: false,
      reason:
        'the approval belongs to a different run — no standing or prior approval satisfies this run',
      changedFields: ['runId'],
    };
  }

  const changedFields = diffBindings(approval.binding, current);
  if (changedFields.length > 0) {
    return {
      valid: false,
      reason: `${describeChangedFields(changedFields)} changed after this was approved — review and approve again`,
      changedFields,
    };
  }

  const currentHash = computeApprovalHash(current);
  if (!safeEqualHex(approval.contentHash, currentHash)) {
    // The field diff found nothing but the hashes disagree: something bound into
    // the hash is not covered by diffBindings. Fail CLOSED and say so plainly
    // rather than trusting the diff.
    return {
      valid: false,
      reason: 'the approved payload no longer matches what is staged — review and approve again',
      changedFields: [],
    };
  }
  return { valid: true, changedFields: [] };
}

/** Build the immutable approval record for a payload the user just approved. */
export function recordApproval(
  binding: ApprovalBinding,
  approvedByUserId: string,
  approvedAt: Date,
): ApprovalRecord {
  return {
    contentHash: computeApprovalHash(binding),
    binding,
    approvedByUserId,
    approvedAt: approvedAt.toISOString(),
    status: 'approved',
    invalidatedAt: null,
    invalidatedReason: null,
    changedFields: null,
  };
}

/** Mark a stored approval invalidated, preserving the original binding. */
export function invalidateApproval(
  approval: ApprovalRecord,
  verification: ApprovalVerification,
  at: Date,
): ApprovalRecord {
  return {
    ...approval,
    status: 'invalidated',
    invalidatedAt: at.toISOString(),
    invalidatedReason: verification.reason ?? 'the approved payload changed',
    changedFields: verification.changedFields,
  };
}

/**
 * A stable fingerprint of the context that produced the content (the audit's
 * "context-pack fingerprint"). Built from the grounding health + the fact ids
 * actually cited, so a context refresh that changes what was cited invalidates
 * the approval.
 */
export function contextPackFingerprint(input: {
  groundingStatus: string | null;
  missingRequired?: readonly string[];
  openMaterialConflictIds?: readonly string[];
  citedFactRefs?: readonly string[];
}): string {
  const canonical = JSON.stringify({
    citedFactRefs: [...new Set(input.citedFactRefs ?? [])].sort(),
    groundingStatus: input.groundingStatus ?? null,
    missingRequired: [...new Set(input.missingRequired ?? [])].sort(),
    openMaterialConflictIds: [...new Set(input.openMaterialConflictIds ?? [])].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}
