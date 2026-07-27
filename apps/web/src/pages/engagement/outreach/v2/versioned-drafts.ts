// Outreach v2 — Phase 0 versioned-draft client logic (plan §3.g1/g2/g4/g5).
//
// Everything here is PURE so the trust-boundary rules are unit-testable without a
// DOM. The rules, restated because each one replaces a specific old bug:
//
//   1. Sendability comes from the SERVER lifecycle. The old code let a local edit
//      flip a failed/held draft to 'edited', and 'edited' was sendable — so a
//      draft no verdict had ever cleared could be blasted out.
//   2. A local edit makes a draft DIRTY, which makes it LESS sendable. Unsaved
//      text has not been audited, so it cannot be sent.
//   3. Held content is PRESERVED and shown. The old mapper collapsed a held
//      result into the same "generation failed" placeholder as a provider outage,
//      destroying content a reviewer was supposed to read.
//   4. Navigation to Send is blocked while anything is dirty, pending, held,
//      unavailable or rejected.

import type {
  DraftApprovalStatus,
  DraftAuditStatus,
  GeneratedDraft,
  WizardV2State,
} from './types.js';

/** The version fields the API returns for one generation slot. */
export interface DraftVersionRef {
  generationKey: string;
  artifactId: string;
  versionId: string;
  version: number;
  generationStatus?: GeneratedDraft['generationStatus'];
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  reviewRequestId?: string;
  sendable: boolean;
  /**
   * Phase 2 §3.f2 — true when the server refused to advance this slot's
   * current version (it was manually authored) and persisted this result as
   * a non-current CANDIDATE instead. `baseVersion` is the artifact's
   * currentVersion the candidate was offered against — required by the
   * accept endpoint's optimistic check, and by DraftVersionCompare to detect
   * a stale candidate.
   */
  isCandidate?: boolean;
  baseVersion?: number;
}

/** A per-recipient result from POST /outreach/generate-batch (versioned shape). */
export interface VersionedBatchResult {
  recipientId: string;
  subject: string;
  body: string;
  status: 'ready' | 'error' | 'held';
  error?: string;
  contextNote?: string;
  generationKey?: string;
  artifactId?: string;
  versionId?: string;
  version?: number;
  generationStatus?: GeneratedDraft['generationStatus'];
  auditStatus?: DraftAuditStatus;
  approvalStatus?: DraftApprovalStatus;
  reviewRequestId?: string;
  sendable?: boolean;
  versions?: DraftVersionRef[];
}

/** Does this draft carry server lifecycle state at all? */
export function isVersioned(draft: GeneratedDraft | undefined): boolean {
  return !!draft?.versionId;
}

/**
 * THE client-side send gate.
 *
 * Mirrors the server's isDraftVersionSendable() and then applies the one extra
 * client-only rule: unsaved keystrokes are never sendable. Fails CLOSED — a
 * draft with no server version is not sendable under versioning.
 */
export function isDraftSendable(draft: GeneratedDraft | undefined): boolean {
  if (!draft) return false;
  // Unsaved local text has not been audited. This is the rule that makes "type a
  // character, press Send" impossible.
  if (draft.dirty) return false;

  // Phase 1 §3.j2 — a CRITICAL source failure blocks Send.
  //
  // Checked before the version lifecycle because the two answer different
  // questions: the audit asks "is what we wrote defensible", the manifest asks
  // "did we actually have the context we claimed to write from". A draft can pass
  // the auditor precisely BECAUSE the missing source produced nothing to
  // contradict — so a clean audit must not override a critical context failure.
  if ((draft.manifest?.criticalFailures?.length ?? 0) > 0) return false;

  if (isVersioned(draft)) {
    // Trust the server's own computation when present; otherwise recompute the
    // identical policy so a partial response cannot open the gate.
    if (typeof draft.sendable === 'boolean') return draft.sendable;
    const approval = draft.approvalStatus ?? 'pending';
    if (approval === 'pending' || approval === 'rejected') return false;
    const audit = draft.auditStatus ?? 'pending';
    return audit === 'not_required' || audit === 'passed' || audit === 'warning';
  }

  // Pre-Phase-0 path (flag off): the legacy 'status' vocabulary still applies.
  return draft.status === 'ready' || draft.status === 'edited';
}

/**
 * Why a draft cannot be sent — the single source of truth for banner copy, so
 * the message a user reads always matches the gate that blocked them.
 */
export type DraftBlockReason =
  | 'missing'
  | 'dirty'
  | 'pending'
  | 'held'
  | 'unavailable'
  | 'rejected'
  | 'awaiting_review'
  | 'generation_failed'
  | 'source_failure'
  | null;

export function draftBlockReason(draft: GeneratedDraft | undefined): DraftBlockReason {
  if (!draft) return 'missing';
  if (draft.dirty) return 'dirty';
  // Phase 1 §3.j2 — must match isDraftSendable's ordering, or the banner would
  // explain a different reason than the one that actually blocked the send.
  if ((draft.manifest?.criticalFailures?.length ?? 0) > 0) return 'source_failure';
  if (isVersioned(draft)) {
    if (draft.generationStatus === 'generation_failed') return 'generation_failed';
    if (draft.auditStatus === 'unavailable') return 'unavailable';
    if (draft.auditStatus === 'held') return 'held';
    if (draft.auditStatus === 'pending') return 'pending';
    if (draft.approvalStatus === 'rejected') return 'rejected';
    if (draft.approvalStatus === 'pending') return 'awaiting_review';
    return null;
  }
  if (draft.status === 'error') return 'generation_failed';
  if (draft.status === 'pending') return 'pending';
  return null;
}

/** User-facing copy per block reason. Held/unavailable are NOT "generation failed". */
export const DRAFT_BLOCK_COPY: Record<Exclude<DraftBlockReason, null>, string> = {
  missing: 'No draft yet for this recipient.',
  dirty: 'Saving your changes — this draft will be verified before it can be sent.',
  pending: 'Verification in progress.',
  held: 'Pending review — a reviewer must approve this draft before it can be sent.',
  unavailable: 'Verification unavailable; this draft cannot be sent.',
  rejected: 'A reviewer rejected this version. Edit it to create a new version.',
  awaiting_review: 'Pending review.',
  generation_failed: 'Generation failed for this recipient. Edit the draft or regenerate.',
  source_failure:
    'Required context could not be loaded, so this draft cannot be sent. See “Source failures” below for what to fix.',
};

/**
 * Fold ONE batch result into the draft map.
 *
 * Held content is kept verbatim with its version metadata, which is the whole
 * point: a held draft is real content a reviewer needs to read, not a failure.
 */
export function applyVersionedResult(
  prior: GeneratedDraft | undefined,
  result: VersionedBatchResult,
  ref: DraftVersionRef | undefined,
  renderBody: (raw: string) => string,
): GeneratedDraft {
  // A genuine generation failure: no version exists, so there is nothing to send
  // and nothing to audit. Keep the slot addressable so the user can author text.
  if (!ref || result.generationStatus === 'generation_failed') {
    return {
      ...prior,
      subject: result.subject ?? '',
      body: result.body ? renderBody(result.body) : '',
      ...(result.artifactId ? { artifactId: result.artifactId } : {}),
      generationStatus: 'generation_failed',
      versionId: undefined,
      sendable: false,
      dirty: false,
      status: 'error',
      localStatus: undefined,
    };
  }

  return {
    subject: result.subject,
    body: renderBody(result.body),
    artifactId: ref.artifactId,
    versionId: ref.versionId,
    version: ref.version,
    generationStatus: ref.generationStatus ?? 'generated',
    auditStatus: ref.auditStatus,
    approvalStatus: ref.approvalStatus,
    ...(ref.reviewRequestId ? { reviewRequestId: ref.reviewRequestId } : {}),
    sendable: ref.sendable,
    ...(result.contextNote ? { contextNote: result.contextNote } : {}),
    // A freshly returned server version is by definition not dirty.
    dirty: false,
    localStatus: undefined,
    // Legacy mirror so any not-yet-migrated reader still behaves safely.
    status: ref.sendable ? 'ready' : 'held',
    ...(prior?.localHistory ? { localHistory: prior.localHistory } : {}),
  };
}

/**
 * Phase 2 §3.f2 — a regeneration the server refused to apply directly because
 * the slot's current version was manually authored. Offered for compare/merge
 * (DraftVersionCompare); the current draft is left completely untouched
 * unless/until the user explicitly accepts it.
 */
export interface DraftCandidate {
  genKey: string;
  artifactId: string;
  candidateVersionId: string;
  candidateVersion: number;
  /** The artifact's currentVersion this candidate was offered against. */
  baseVersion: number;
  subject: string;
  body: string;
}

/**
 * Map a batch response onto its slots.
 *
 * A slot is matched to the version whose generationKey it owns — NOT to the
 * recipient — because one generated draft legitimately backs several slots (the
 * same person in two lists is generated once, then versioned per slot).
 *
 * A slot whose ref is a CANDIDATE (§3.f2) is deliberately excluded from
 * `patches` — applying it would silently replace whatever the slot currently
 * shows, which is exactly the destructive regeneration this phase forbids.
 * It surfaces in `candidates` instead.
 */
export function partitionVersionedResults(
  slots: Array<{ genKey: string; resultId: string }>,
  results: VersionedBatchResult[],
  renderBody: (raw: string) => string,
): {
  patches: Array<{ genKey: string; draft: GeneratedDraft }>;
  failedGenKeys: string[];
  heldGenKeys: string[];
  candidates: DraftCandidate[];
} {
  const byRecipient = new Map(results.map((r) => [r.recipientId, r]));
  const refByGenKey = new Map<string, { ref: DraftVersionRef; result: VersionedBatchResult }>();
  for (const r of results) {
    for (const ref of r.versions ?? []) refByGenKey.set(ref.generationKey, { ref, result: r });
    // Flat single-key form.
    if (!r.versions?.length && r.generationKey && r.versionId && r.artifactId) {
      refByGenKey.set(r.generationKey, {
        ref: {
          generationKey: r.generationKey,
          artifactId: r.artifactId,
          versionId: r.versionId,
          version: r.version ?? 1,
          generationStatus: r.generationStatus,
          auditStatus: r.auditStatus ?? 'pending',
          approvalStatus: r.approvalStatus ?? 'not_required',
          ...(r.reviewRequestId ? { reviewRequestId: r.reviewRequestId } : {}),
          sendable: r.sendable === true,
        },
        result: r,
      });
    }
  }

  const patches: Array<{ genKey: string; draft: GeneratedDraft }> = [];
  const failedGenKeys: string[] = [];
  const heldGenKeys: string[] = [];
  const candidates: DraftCandidate[] = [];

  for (const slot of slots) {
    const matched = refByGenKey.get(slot.genKey);
    const result = matched?.result ?? byRecipient.get(slot.resultId);
    if (!result) {
      // The backend dropped this slot entirely.
      failedGenKeys.push(slot.genKey);
      continue;
    }
    if (matched?.ref?.isCandidate) {
      candidates.push({
        genKey: slot.genKey,
        artifactId: matched.ref.artifactId,
        candidateVersionId: matched.ref.versionId,
        candidateVersion: matched.ref.version,
        baseVersion: matched.ref.baseVersion ?? matched.ref.version - 1,
        subject: result.subject,
        body: renderBody(result.body),
      });
      continue;
    }
    const draft = applyVersionedResult(undefined, result, matched?.ref, renderBody);
    patches.push({ genKey: slot.genKey, draft });
    if (draft.generationStatus === 'generation_failed') failedGenKeys.push(slot.genKey);
    else if (!draft.sendable) heldGenKeys.push(slot.genKey);
  }

  return { patches, failedGenKeys, heldGenKeys, candidates };
}

/** Mark a draft dirty on the first keystroke — immediately non-sendable. */
export function markDirty(
  draft: GeneratedDraft,
  patch: { subject?: string; body?: string },
): GeneratedDraft {
  return {
    ...draft,
    ...patch,
    dirty: true,
    // Sendability is revoked the moment the text diverges from the audited
    // version; only a server round-trip can restore it.
    sendable: false,
    localStatus: undefined,
  };
}

/** Fold a POST .../versions response back into the slot. */
export function applyNewVersion(
  draft: GeneratedDraft,
  version: {
    id: string;
    artifactId: string;
    version: number;
    subject: string;
    body: string;
    generationStatus: GeneratedDraft['generationStatus'];
    auditStatus: DraftAuditStatus;
    approvalStatus: DraftApprovalStatus;
    reviewRequestId?: string | null;
    sendable: boolean;
    contextNote?: string;
  },
): GeneratedDraft {
  return {
    ...draft,
    subject: version.subject,
    body: version.body,
    artifactId: version.artifactId,
    versionId: version.id,
    version: version.version,
    generationStatus: version.generationStatus,
    auditStatus: version.auditStatus,
    approvalStatus: version.approvalStatus,
    reviewRequestId: version.reviewRequestId ?? undefined,
    sendable: version.sendable,
    ...(version.contextNote ? { contextNote: version.contextNote } : {}),
    dirty: false,
    localStatus: undefined,
    status: version.sendable ? 'ready' : 'held',
  };
}

/**
 * A 409 from the version endpoint: someone else appended first.
 *
 * The local text is KEPT (the user's work is not thrown away) and the draft is
 * flagged `conflict` so the UI can offer "Load latest". Autosave must stop —
 * retrying would either overwrite the winner or loop forever.
 */
export function applyVersionConflict(
  draft: GeneratedDraft,
  conflict: { currentVersionId?: string | null },
): GeneratedDraft {
  return {
    ...draft,
    // Still dirty (unsaved) and definitely not sendable.
    dirty: true,
    sendable: false,
    localStatus: 'conflict',
    ...(conflict.currentVersionId ? { versionId: draft.versionId } : {}),
  };
}

/** Every slot that must settle before the Send step may be entered. */
export function unsettledGenKeys(
  slots: Array<{ genKey: string }>,
  generated: WizardV2State['generatedEmails'],
): string[] {
  return slots.filter((s) => !isDraftSendable(generated[s.genKey])).map((s) => s.genKey);
}

/** Slots with unsaved keystrokes that must be flushed and awaited first. */
export function dirtyGenKeys(
  slots: Array<{ genKey: string }>,
  generated: WizardV2State['generatedEmails'],
): string[] {
  return slots.filter((s) => generated[s.genKey]?.dirty === true).map((s) => s.genKey);
}

/**
 * May the wizard advance to Send?
 *
 * Deliberately conservative: ANY unsettled slot blocks. A partial send is a
 * decision for the user to make explicitly, not something to fall into by
 * navigating past a held draft.
 */
export function canEnterSendStep(
  slots: Array<{ genKey: string }>,
  generated: WizardV2State['generatedEmails'],
): { ok: boolean; blocked: string[]; dirty: string[] } {
  const dirty = dirtyGenKeys(slots, generated);
  const blocked = unsettledGenKeys(slots, generated);
  return { ok: blocked.length === 0, blocked, dirty };
}

/** How many slots are ready, for the rail's "N / N ready" pill. */
export function readyCount(
  slots: Array<{ genKey: string }>,
  generated: WizardV2State['generatedEmails'],
): number {
  return slots.filter((s) => isDraftSendable(generated[s.genKey])).length;
}

/** Autosave debounce (ms) per artifact, per §3.g4. */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 800;
