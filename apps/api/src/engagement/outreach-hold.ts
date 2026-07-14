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
 */
import { createHash } from 'node:crypto';

/** review_request.subjectType for content-addressed held outreach drafts. */
export const OUTREACH_HOLD_SUBJECT_TYPE = 'outreach-draft';

/**
 * Review statuses that keep a held draft NON-sendable. 'approved' releases it;
 * 'rejected' means a reviewer said do-not-send, so it stays blocked.
 */
export const OUTREACH_HOLD_BLOCKING_STATUSES = ['pending', 'rejected'] as const;

/** Deterministic content key: same (recipient, subject, body) → same key. */
export function outreachDraftHoldKey(recipientId: string, subject: string, body: string): string {
  const digest = createHash('sha256')
    .update(`${recipientId}\n${subject}\n${body}`, 'utf8')
    .digest('hex');
  return `sha256:${digest.slice(0, 40)}`;
}
