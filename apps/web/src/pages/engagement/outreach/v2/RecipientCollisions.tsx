// Phase 2 §3.g — recipient-collision resolution panel.
//
// Current target semantics INTENTIONALLY allow a person to receive both a
// personal email (individual/list) and a group email (see targets.ts). This
// panel never silently dedupes anything: every collision requires an
// EXPLICIT choice — Keep all messages, Remove the individual/list occurrence,
// Remove from a group, or Merge duplicate personal entries. "Keep all" is
// recorded as an acknowledgement (persisted in wizard state, tied to a
// fingerprint of the current collision set); the other three choices mutate
// `targets` directly, which makes the collision disappear on its own.

import {
  analyzeRecipientCollisions,
  collisionsFingerprint,
  type OutreachTarget,
  type RecipientCollision,
} from './targets.js';
import type { WizardV2State } from './types.js';

export type CollisionResolution = WizardV2State['collisionResolution'];

interface Props {
  targets: OutreachTarget[];
  onTargetsChange: (next: OutreachTarget[]) => void;
  resolution: CollisionResolution;
  onResolutionChange: (next: CollisionResolution) => void;
}

function describeAppearances(c: RecipientCollision): string {
  const parts: string[] = [];
  if (c.individualToCount) parts.push('an individual email');
  if (c.listToCount) parts.push(`${c.listToCount === 1 ? 'a' : c.listToCount} list email${c.listToCount > 1 ? 's' : ''}`);
  if (c.groupToCount) parts.push(`${c.groupToCount} group email${c.groupToCount > 1 ? 's' : ''}`);
  if (!parts.length && c.ccOverlapsOwnTo) return 'Cc/Bcc’d on their own email';
  return parts.join(' + ') || 'multiple entries';
}

/** Remove every individual/list occurrence of `email`; drops a target that becomes empty. */
export function removePersonalOccurrences(targets: OutreachTarget[], email: string): OutreachTarget[] {
  return targets
    .map((t) => {
      if (t.type !== 'individual' && t.type !== 'list') return t;
      const recipients = t.recipients.filter((r) => (r.email ?? '').trim().toLowerCase() !== email);
      return recipients.length === t.recipients.length ? t : { ...t, recipients };
    })
    .filter((t) => t.recipients.length > 0);
}

/** Remove `email` from one specific group target; drops the target if it becomes empty. */
export function removeFromGroup(targets: OutreachTarget[], email: string, groupKey: string): OutreachTarget[] {
  return targets
    .map((t) => {
      if (t.type !== 'group' || t.key !== groupKey) return t;
      return { ...t, recipients: t.recipients.filter((r) => (r.email ?? '').trim().toLowerCase() !== email) };
    })
    .filter((t) => t.recipients.length > 0);
}

/**
 * Merge duplicate personal (individual/list) entries for the same email into
 * the FIRST occurrence: fold the others' target-level Cc/Bcc into it rather
 * than silently dropping them, then remove the duplicate occurrences.
 */
export function mergePersonalOccurrences(targets: OutreachTarget[], email: string): OutreachTarget[] {
  const personalIdx = targets
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (t.type === 'individual' || t.type === 'list') && t.recipients.some((r) => (r.email ?? '').trim().toLowerCase() === email));
  if (personalIdx.length < 2) return targets;
  const [first, ...rest] = personalIdx;
  const mergedCc = new Set(first!.t.cc);
  const mergedBcc = new Set(first!.t.bcc);
  for (const { t } of rest) {
    for (const e of t.cc) mergedCc.add(e);
    for (const e of t.bcc) mergedBcc.add(e);
  }
  const dropKeys = new Set(rest.map(({ t }) => t.key));
  return targets
    .map((t) => {
      if (t.key === first!.t.key) return { ...t, cc: Array.from(mergedCc), bcc: Array.from(mergedBcc) };
      if (!dropKeys.has(t.key)) return t;
      // A duplicate LIST target may have other members besides this one —
      // only drop the colliding member, not the whole target, unless it was
      // an individual (single-recipient) target.
      if (t.type === 'list') {
        return { ...t, recipients: t.recipients.filter((r) => (r.email ?? '').trim().toLowerCase() !== email) };
      }
      return null;
    })
    .filter((t): t is OutreachTarget => t !== null && t.recipients.length > 0);
}

export function RecipientCollisions({ targets, onTargetsChange, resolution, onResolutionChange }: Props) {
  const collisions = analyzeRecipientCollisions(targets);
  if (collisions.length === 0) return null;
  const fingerprint = collisionsFingerprint(collisions);
  // A prior acknowledgement only counts against the fingerprint it was made
  // for — any target edit since then re-opens every collision for review.
  const keptEmails = resolution?.fingerprint === fingerprint ? new Set(resolution.keepAllEmails) : new Set<string>();

  const keepAll = (email: string) => {
    const next = resolution?.fingerprint === fingerprint ? [...resolution.keepAllEmails, email] : [email];
    onResolutionChange({ fingerprint, keepAllEmails: Array.from(new Set(next)) });
  };

  return (
    <div className="ov2-collision-panel" role="region" aria-label="Recipient collisions">
      <div className="ov2-collision-head">
        <span className="ov2-collision-head-title">
          {collisions.length} recipient {collisions.length === 1 ? 'collision' : 'collisions'} to resolve
        </span>
        <span className="ov2-collision-head-sub">
          Someone below is set up to receive more than one email, or a Cc/Bcc duplicates their own To.
        </span>
      </div>
      {collisions.map((c) => {
        const resolved = keptEmails.has(c.email);
        const groupAppearances = Array.from(
          new Map(
            c.appearances
              .filter((a) => a.role === 'to' && a.targetType === 'group')
              .map((a) => [a.targetKey, a.targetName ?? 'Untitled group']),
          ),
        );
        const canMerge = c.identityMismatch && c.individualToCount + c.listToCount >= 2;
        return (
          <div key={c.email} className={'ov2-collision-item' + (resolved ? ' resolved' : '')}>
            <div className="ov2-collision-item-main">
              <span className="ov2-collision-email">{c.email}</span>
              <span className="ov2-collision-desc">{describeAppearances(c)}</span>
              {c.identityMismatch && <span className="ov2-collision-flag">different name on each entry</span>}
              {c.ccOverlapsOwnTo && <span className="ov2-collision-flag">Cc/Bcc duplicates their own To</span>}
            </div>
            <div className="ov2-collision-actions">
              <button
                type="button"
                className={'ov2-collision-btn' + (resolved ? ' active' : '')}
                onClick={() => keepAll(c.email)}
              >
                Keep all messages
              </button>
              {(c.individualToCount > 0 || c.listToCount > 0) && (
                <button
                  type="button"
                  className="ov2-collision-btn"
                  onClick={() => onTargetsChange(removePersonalOccurrences(targets, c.email))}
                >
                  Remove individual/list occurrence
                </button>
              )}
              {canMerge && (
                <button
                  type="button"
                  className="ov2-collision-btn"
                  onClick={() => onTargetsChange(mergePersonalOccurrences(targets, c.email))}
                >
                  Merge personal occurrences
                </button>
              )}
              {groupAppearances.map(([groupKey, groupName]) => (
                <button
                  key={groupKey}
                  type="button"
                  className="ov2-collision-btn"
                  onClick={() => onTargetsChange(removeFromGroup(targets, c.email, groupKey))}
                >
                  Remove from “{groupName}”
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Whether every current collision has an explicit resolution — either
 * acknowledged "keep all" against the CURRENT fingerprint, or structurally
 * resolved (no longer appearing in analyzeRecipientCollisions at all).
 * Send preflight (§3.h) uses this to block until true.
 */
export function collisionsResolved(targets: OutreachTarget[], resolution: CollisionResolution): boolean {
  const collisions = analyzeRecipientCollisions(targets);
  if (collisions.length === 0) return true;
  if (!resolution) return false;
  const fingerprint = collisionsFingerprint(collisions);
  if (resolution.fingerprint !== fingerprint) return false;
  const kept = new Set(resolution.keepAllEmails);
  return collisions.every((c) => kept.has(c.email));
}
