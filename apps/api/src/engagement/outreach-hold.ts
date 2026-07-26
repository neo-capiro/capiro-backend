/**
 * §3.3 server-side outreach hold — content-addressed keys.
 *
 * Generation and send share NO campaign identifier (GenerateBatchEmailInput has
 * no engagementId; SendBatchEmailInput's is optional), so a held draft is keyed
 * by its CONTENT: recipient key + exact subject + exact body. The wizard
 * round-trips drafts verbatim, so an unedited held draft hashes to the same key
 * at send time and is refused server-side until a reviewer APPROVES it in
 * Reviews. Any edit produces a different key — deliberately: the edited text is
 * new content the generation-time verdict never judged (mirrors how alert-memo
 * holds attach to the audited artifact, not to the recipient forever).
 *
 * ⚠️ SUPERSEDED BY PHASE 0 (§3.b3). Holds now attach to an IMMUTABLE DRAFT
 * VERSION id (`review_request.subjectType = 'outreach-draft-version'`), not to a
 * content hash. Content addressing was the flaw: because "any edit is new
 * content", a held draft became sendable the moment a user changed one character
 * — no fresh verdict required, no review. A versioned hold cannot be edited out
 * of, because the edit creates a new version that must earn its own verdict.
 *
 * Everything below is retained for exactly two reasons:
 *   1. reading/displaying HISTORICAL review rows, which must stay viewable; and
 *   2. the pre-Phase-0 path that still runs while ENGAGEMENT_VERSIONED_OUTREACH
 *      is false (removing it there would leave that path with no hold gate).
 *
 * Do NOT create new review rows with subjectType='outreach-draft', and do not
 * make any new send decision depend on a content key.
 */
import { createHash } from 'node:crypto';

/**
 * review_request.subjectType for content-addressed held outreach drafts.
 *
 * @deprecated Phase 0 — new holds use OUTREACH_DRAFT_VERSION_SUBJECT_TYPE
 * ('outreach-draft-version') in outreach-draft.types.ts. This constant exists to
 * read historical rows and to serve the flag-off legacy path.
 */
export const OUTREACH_HOLD_SUBJECT_TYPE = 'outreach-draft';

/**
 * Review statuses that keep a held draft NON-sendable. 'approved' releases it;
 * 'rejected' means a reviewer said do-not-send, so it stays blocked.
 */
export const OUTREACH_HOLD_BLOCKING_STATUSES = ['pending', 'rejected'] as const;

/**
 * Deterministic content key: same (recipient, subject, body) → same key.
 *
 * @deprecated Phase 0 §3.b3 — kept ONLY so historical review rows keep resolving
 * to the same key. No new send decision may consult it; sendability is a property
 * of an immutable draft version (see isDraftVersionSendable).
 */
export function outreachDraftHoldKey(recipientId: string, subject: string, body: string): string {
  const digest = createHash('sha256')
    .update(`${recipientId}\n${subject}\n${body}`, 'utf8')
    .digest('hex');
  return `sha256:${digest.slice(0, 40)}`;
}
