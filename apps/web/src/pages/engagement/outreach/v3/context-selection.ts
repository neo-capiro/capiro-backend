/**
 * Context purpose/scope decomposition for the Outreach V3 Context stage.
 *
 * The backend models five context classes (`required_policy`,
 * `writing_guidance`, `campaign_fact`, `target_specific`, `group_safe`). Asking
 * the user to name one of those BEFORE searching was the single biggest source
 * of confusion in the stage, and it bought nothing: the authoritative gate is
 * `assertClassCompatibility()` in
 * `apps/api/src/capabilities/context/outreach-context-reference.service.ts`,
 * which runs server-side at ACCEPT time against the freshly re-resolved record
 * and overwrites every trust flag regardless of what the browser asked for.
 *
 * So the class is a decision about ONE item you are looking at, not a filter
 * you declare up front. This module restates the five classes as the two
 * orthogonal questions they actually encode:
 *
 *   purpose:    evidence | guidance | policy
 *   applies to: the whole campaign | one selected target
 *
 * and maps that pair back onto the canonical class + scope:
 *
 *   evidence + campaign  -> campaign_fact    / { kind: 'campaign' }
 *   evidence + target    -> target_specific  / { kind: 'target', targetKey }
 *   guidance             -> writing_guidance / { kind: 'campaign' }
 *   policy               -> required_policy  / { kind: 'campaign' }
 *
 * `group_safe` has no representation here on purpose: it requires group scope,
 * and no audience-group source exists yet, so offering it could only ever
 * produce a guaranteed 422.
 */
import type {
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextSelection,
} from './contracts.js';

export type OutreachV3ContextPurpose = 'evidence' | 'guidance' | 'policy';

export interface ContextPurposeOption {
  value: OutreachV3ContextPurpose;
  label: string;
  hint: string;
  allowed: boolean;
  /** Why the purpose is unavailable for this source. Null when allowed. */
  blockedReason: string | null;
}

/**
 * Can this source supply writing instructions?
 *
 * Exactly mirrors the server gate: `contextClass === 'writing_guidance' &&
 * !source.instructionsAllowed` throws. `instructionsAllowed` is true only for
 * memory items whose row carries it — government records and stored documents
 * both hard-code `instructionsAllowed: false` in their resolvers.
 */
export function canBeGuidance(candidate: OutreachV3ContextCandidate): boolean {
  return candidate.sourceKind === 'memory' && candidate.instructionsAllowed === true;
}

/**
 * Could this source satisfy `required_policy`?
 *
 * The server requires `source.usableAsEvidence`, which the search payloads do
 * not carry in full:
 *
 *   - government records resolve `usableAsEvidence: true` unconditionally, so
 *     policy is always available;
 *   - memory resolves `approved && !conflicted && !expired`. A candidate whose
 *     `verificationClass` is 'unverified' came from a pending/proposed governed
 *     status, so it can NEVER be approved — that one we can rule out exactly.
 *     The remaining classes are probable but not provable from the candidate
 *     alone (conflict and expiry are not in the search projection);
 *   - documents resolve `approvedAt || sharedAt`, neither of which the context
 *     library returns.
 *
 * Where it is not provable we allow the attempt rather than guess, and the
 * server's own sentence is surfaced if it refuses. Guessing "ineligible" would
 * hide legitimately usable policy sources; guessing "eligible" and failing at
 * least tells the truth.
 */
export function canBePolicy(candidate: OutreachV3ContextCandidate): boolean {
  if (candidate.sourceKind === 'memory') return candidate.verificationClass !== 'unverified';
  return true;
}

export function contextPurposeOptions(
  candidate: OutreachV3ContextCandidate,
): ContextPurposeOption[] {
  const guidance = canBeGuidance(candidate);
  const policy = canBePolicy(candidate);
  return [
    {
      value: 'evidence',
      label: 'Evidence',
      hint: 'A fact Meri may state and cite.',
      allowed: true,
      blockedReason: null,
    },
    {
      value: 'guidance',
      label: 'Writing guidance',
      hint: 'Shapes tone only. Never cited as a fact.',
      allowed: guidance,
      blockedReason: guidance
        ? null
        : candidate.sourceKind === 'memory'
          ? 'This memory item is not marked as allowed to give writing instructions.'
          : 'Only institutional-memory items can carry writing instructions.',
    },
    {
      value: 'policy',
      label: 'Required policy',
      hint: 'A rule every draft must follow.',
      allowed: policy,
      blockedReason: policy
        ? null
        : 'Required policy must come from a verified source, and this item is still unverified.',
    },
  ];
}

/**
 * The purpose to preselect, or null when the choice is genuinely ambiguous.
 *
 * A source that cannot be guidance has only one sensible reading — it is
 * factual — so preselecting 'evidence' saves a click without deciding anything
 * the user might disagree with. A source that CAN be guidance is exactly the
 * ambiguous case (a style note read as a citable fact is a real governance
 * error), so nothing is preselected and the accept control stays disabled.
 */
export function defaultContextPurpose(
  candidate: OutreachV3ContextCandidate,
): OutreachV3ContextPurpose | null {
  return canBeGuidance(candidate) ? null : 'evidence';
}

export function contextClassForPurpose(
  purpose: OutreachV3ContextPurpose,
  targetKey: string | null,
): OutreachV3ContextClass {
  if (purpose === 'guidance') return 'writing_guidance';
  if (purpose === 'policy') return 'required_policy';
  return targetKey ? 'target_specific' : 'campaign_fact';
}

/**
 * Build the exact selection to send with ACCEPT_CONTEXT_REFS.
 *
 * The locator is carried through from the search result untouched. Only the
 * class and scope are (re)decided here, because those are the two things the
 * user just chose — and the server re-resolves the locator and re-derives every
 * trust flag anyway, so nothing here is trusted as an assertion about content.
 */
export function contextSelectionFor(
  candidate: OutreachV3ContextCandidate,
  purpose: OutreachV3ContextPurpose,
  targetKey: string | null,
): OutreachV3ContextSelection {
  // Target scope is meaningful only for factual evidence: writing_guidance and
  // required_policy are campaign-wide by definition on the server.
  const scopedTargetKey = purpose === 'evidence' ? targetKey : null;
  return contextSelectionForClass(
    candidate,
    contextClassForPurpose(purpose, scopedTargetKey),
    scopedTargetKey,
  );
}

/**
 * Same as `contextSelectionFor`, for a caller that already holds a canonical
 * class rather than a purpose. Keeps scope derivation in one place so a class
 * can never travel with a scope the server would reject.
 */
export function contextSelectionForClass(
  candidate: OutreachV3ContextCandidate,
  contextClass: OutreachV3ContextClass,
  targetKey: string | null,
): OutreachV3ContextSelection {
  const scopedTargetKey = contextClass === 'target_specific' ? targetKey : null;
  return {
    locator: candidate.selection.locator,
    contextClass,
    scope: scopedTargetKey ? { kind: 'target', targetKey: scopedTargetKey } : { kind: 'campaign' },
  };
}

/** Stable identity for a candidate across re-searches and merged sources. */
export function contextCandidateKey(candidate: OutreachV3ContextCandidate): string {
  const locator = candidate.selection.locator;
  return [
    locator.source ?? '',
    typeof locator.category === 'string' ? locator.category : '',
    typeof locator.id === 'string' ? locator.id : '',
  ].join(':');
}
