/**
 * Comment-deadline alert dedup key (Phase 1 M3.4, PD4). Shared by the
 * scheduled `check-comment-periods.ts` verb AND `intelligence.service.ts`'s
 * on-demand `getCommentPeriodAlerts` (the dashboard chip read, which ALSO
 * writes `IntelligenceChange` rows as a side effect on every call) — two
 * callers of the SAME business rule, unlike the per-site grounded-generation
 * pattern elsewhere in this codebase, so this one piece is genuinely shared
 * rather than duplicated.
 *
 * Before this, NEITHER caller set `IntelligenceChange.dedupeKey` — a
 * scheduled re-run, or simply reloading the dashboard twice, created a fresh
 * duplicate row for the same (document, client) pair every time. Both
 * callers now `upsert` on this key instead of `create`, closing that gap for
 * both the federal path (pre-existing) and the new state path (M3.4).
 */
export function commentDeadlineDedupeKey(
  source: 'federal_register' | 'state_register',
  documentId: string,
  clientId: string,
): string {
  return `comment_deadline:${source}:${documentId}:${clientId}`;
}
