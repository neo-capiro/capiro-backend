import { MEMORY_PERMISSIONS, type MemoryPermission } from './memory-authorization.helpers.js';
import {
  assertMemoryTransition,
  governedMemoryLifecycleEnabled,
  type GovernedMemoryStatus,
  type MemoryAuthority,
  type MemoryClass,
  type MemoryTransitionReasonCode,
  type GovernedMemoryScope,
} from '@capiro/meriv2-core';

/**
 * Arms the governed-memory LIFECYCLE (`MEMORY_GOVERNANCE_LIFECYCLE=enforce`).
 * Dark by default; defined in packages/meriv2-core/src/memory/governance.ts so
 * apps/meriv2-orchestrator gates the same behaviour off the same parser, and
 * re-exported here so apps/api call sites keep one local import.
 *
 * Everything behind this switch WRITES or READS a column introduced by
 * 20260729010000_memory_governance_context_v2 / 20260729011000_memory_governance_lineage
 * (memory_class, memory_authority, memory_scope, governed_status,
 * approved_by_user_id, memory_transition_audit, memory_cleanup_outbox). NEITHER
 * migration is applied in any environment, so an armed-by-default code path would
 * fail on a missing column/relation for every memory write. Arming is therefore a
 * deliberate post-migration canary step.
 *
 * It is a SEPARATE switch from MEMORY_GOVERNANCE_ENFORCE on purpose:
 * MEMORY_GOVERNANCE_ENFORCE decides *authority* (who may act), this one decides
 * *bookkeeping + suppression* (what the row records and what recall withholds).
 * They can be rolled independently.
 */
export { governedMemoryLifecycleEnabled };

/** The candidate lifecycle decisions MemoryCandidateService records. */
export type CandidateDecision = 'auto_committed' | 'approved' | 'rejected' | 'withdrawn';

/**
 * Candidate-only terminal reason. Governed status remains `rejected` because no
 * canonical memory exists, while the legacy candidate status and audit reason
 * preserve whether the proposer withdrew or an independent reviewer rejected.
 */
export type CandidateTransitionReasonCode =
  | MemoryTransitionReasonCode
  | 'withdrawn_by_proposer'
  | 'rejected_by_reviewer';

/** Legacy `memory_candidate.scope` vocabulary (personal | firm | client). */
export type LegacyCandidateScope = 'personal' | 'firm' | 'client';

export interface CandidateClassificationInput {
  /** The legacy `scope` column value, which is what the service already has. */
  scope: LegacyCandidateScope;
  /** `memory_candidate.source_kind` — 'model_extraction' never earns approval. */
  sourceKind?: string | null;
  /** True when the proposed memory carries a TTL (ephemeral/working memory). */
  hasTtl?: boolean;
}

export interface CandidateClassification {
  memoryClass: MemoryClass;
  memoryScope: GovernedMemoryScope;
  /**
   * Authority granted only by a COMMITTING decision. `null` means "leave the
   * column at its conservative default" — a rejected or withdrawn proposal must
   * never come out of review holding authority it did not earn.
   */
  memoryAuthority: MemoryAuthority | null;
}

const LEGACY_SCOPE_TO_GOVERNED: Readonly<Record<LegacyCandidateScope, GovernedMemoryScope>> = {
  personal: 'user_private',
  client: 'client',
  firm: 'firm',
};

/** Legacy `scope` → the v2 `memory_scope` vocabulary. Mirrors the migration's backfill. */
export function governedScopeForLegacyScope(scope: string | null | undefined): GovernedMemoryScope {
  return LEGACY_SCOPE_TO_GOVERNED[(scope ?? 'firm') as LegacyCandidateScope] ?? 'firm';
}

/**
 * Classify a candidate for the governed columns.
 *
 * Deliberately conservative in two ways the DB CHECKs also care about:
 *  - `episodic_working` is chosen ONLY when a TTL exists, because
 *    memory_candidate_ephemeral_ttl_check / memory_items_ephemeral_ttl_check
 *    reject that class without expires_at/valid_until. Getting this wrong is a
 *    constraint violation on the approval path, not a soft mislabel.
 *  - a model extraction never receives an *_approved authority. A defensive
 *    auto-commit remains `model_inferred`; only the explicit human-review path
 *    may promote it to `analyst_verified`.
 */
export function classifyCandidateForGovernance(
  input: CandidateClassificationInput,
  decision: CandidateDecision,
): CandidateClassification {
  const memoryScope = LEGACY_SCOPE_TO_GOVERNED[input.scope] ?? 'firm';
  const machine = input.sourceKind === 'model_extraction';
  const memoryClass: MemoryClass =
    memoryScope === 'client'
      ? 'client_steering'
      : memoryScope === 'firm'
        ? 'institutional_authoritative'
        : input.hasTtl
          ? 'episodic_working'
          : 'user_preference';

  if (decision === 'rejected' || decision === 'withdrawn') {
    return { memoryClass, memoryScope, memoryAuthority: null };
  }
  if (machine) {
    return {
      memoryClass,
      memoryScope,
      memoryAuthority: decision === 'approved' ? 'analyst_verified' : 'model_inferred',
    };
  }
  const memoryAuthority: MemoryAuthority =
    memoryScope === 'client'
      ? 'client_approved'
      : memoryScope === 'firm'
        ? 'firm_approved'
        : 'user_asserted';
  return { memoryClass, memoryScope, memoryAuthority };
}

export interface GovernedTransitionHop {
  from: GovernedMemoryStatus;
  to: GovernedMemoryStatus;
  reasonCode: CandidateTransitionReasonCode;
}

const REASON_FOR_TARGET: Partial<Record<GovernedMemoryStatus, MemoryTransitionReasonCode>> = {
  pending_review: 'submitted_for_review',
  active: 'approved',
  rejected: 'rejected',
  superseded: 'superseded',
  revoked: 'revoked',
  expired: 'ttl_expired',
};

/**
 * The ordered, individually-legal hops that carry a candidate from its current
 * governed status to the status its decision implies.
 *
 * This exists because the state machine in meriv2-core (TRANSITIONS) does NOT
 * allow suggested → active, and a brand-new candidate row is created at the
 * column default 'suggested' (see schema.prisma's MemoryCandidate comment) —
 * while an auto-committed save goes straight to active in ONE service call. Both
 * facts are real, so the honest recording is two hops: the implicit submission
 * and then the approval. `assertMemoryTransition` validates every hop, so this is
 * the first production consumer of the state machine rather than a bypass of it.
 *
 * Withdrawal and reviewer rejection both land in the non-recallable governed
 * terminal state `rejected`, but carry distinct legacy status and audit reason.
 *
 * Returns [] when the candidate is already in the target state (idempotent
 * re-decide), and throws InvalidMemoryTransitionError for an impossible path.
 */
export function candidateTransitionPath(
  from: GovernedMemoryStatus,
  decision: CandidateDecision,
): GovernedTransitionHop[] {
  const target: GovernedMemoryStatus =
    decision === 'rejected' || decision === 'withdrawn' ? 'rejected' : 'active';
  if (from === target) return [];
  const statuses: GovernedMemoryStatus[] =
    from === 'suggested' && target === 'active' ? ['pending_review', 'active'] : [target];
  const hops: GovernedTransitionHop[] = [];
  let cursor = from;
  for (const to of statuses) {
    assertMemoryTransition(cursor, to);
    const reasonCode: CandidateTransitionReasonCode =
      to === 'rejected' && decision === 'withdrawn'
        ? 'withdrawn_by_proposer'
        : to === 'rejected' && decision === 'rejected'
          ? 'rejected_by_reviewer'
          : (REASON_FOR_TARGET[to] ?? 'approved');
    hops.push({ from: cursor, to, reasonCode });
    cursor = to;
  }
  return hops;
}

/** The governed status a legacy candidate decision lands on. */
export function governedStatusForDecision(decision: CandidateDecision): GovernedMemoryStatus {
  return decision === 'rejected' || decision === 'withdrawn' ? 'rejected' : 'active';
}

// ── memory_transition_audit metadata hygiene ────────────────────────────────
//
// memory_transition_audit is SOC 2 evidence and is explicitly documented as
// "ids/status/reason only, never bodies". Two independent guards below:
// a key denylist (so a caller cannot accidentally hand us a memory body) and a
// hard byte cap matching memory_transition_metadata_size_check.

/** octet cap from memory_transition_metadata_size_check (20260729010000:291). */
export const AUDIT_METADATA_MAX_BYTES = 32_768;

/** Keys that carry memory CONTENT. Dropped unconditionally, never truncated in. */
const CONTENT_KEY_DENYLIST = new Set([
  'body',
  'content',
  'excerpt',
  'markdown',
  'payload',
  'section',
  'sections',
  'sourceexcerpt',
  'text',
  'title',
  'value',
]);

const MAX_METADATA_STRING = 256;

/**
 * Reduce arbitrary metadata to audit-safe scalars: primitives only (no nesting,
 * so a body cannot hide one level down), content-bearing keys dropped, strings
 * capped, and the whole object dropped key-by-key until it fits the CHECK. A
 * violated CHECK would abort the caller's transaction — i.e. an oversized debug
 * field would roll back the state change it was describing.
 */
export function sanitizeAuditMetadata(
  input: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (CONTENT_KEY_DENYLIST.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_METADATA_STRING);
    } else if (typeof value === 'number') {
      out[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
    // objects / arrays / functions / symbols are intentionally dropped
  }
  // Byte cap: drop the largest remaining key until it fits.
  while (byteLength(JSON.stringify(out)) > AUDIT_METADATA_MAX_BYTES) {
    const widest = Object.keys(out).sort(
      (a, b) => byteLength(JSON.stringify(out[b])) - byteLength(JSON.stringify(out[a])),
    )[0];
    if (widest === undefined) break;
    delete out[widest];
  }
  return out;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** `reason` is NOT NULL free text; keep it a one-line explanation, never a body. */
export function normalizeAuditReason(reason: string | null | undefined, fallback: string): string {
  const trimmed = String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return (trimmed || fallback).slice(0, 500);
}

/**
 * Validate a caller-supplied permission list against the ONE vocabulary shared by
 * MEMORY_PERMISSIONS and memory_access_grant_permissions_check (20260729010000:250).
 * Returns the de-duplicated, canonically-ordered list, or null when anything is
 * unrecognised — so the DB CHECK is never the first line of defence.
 */
export function normalizeGrantPermissions(input: unknown): MemoryPermission[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set<MemoryPermission>();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase() as MemoryPermission;
    if (!(MEMORY_PERMISSIONS as readonly string[]).includes(value)) return null;
    seen.add(value);
  }
  return MEMORY_PERMISSIONS.filter((p) => seen.has(p));
}
