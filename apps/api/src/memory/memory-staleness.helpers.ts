/**
 * P2 — memory staleness (blueprint §3.2 "detect stale … client positions",
 * §12.6 "stale-memory use rate", risk-row "confirmation cadence"). Pure,
 * DB-free, unit-tested.
 *
 * A durable memory becomes REVIEW-DUE when a human hasn't re-affirmed it within
 * its configured cadence: `reviewCadenceDays` days after it was last confirmed
 * (or, if never confirmed, after it was created). Memories with no cadence set
 * are never due (opt-in). This is a SURFACING signal — due ≠ wrong, so it never
 * blocks recall; it flags items a reviewer should reconfirm.
 *
 * v1 deliberately covers only this deterministic staleness pass. Automatic
 * SEMANTIC contradiction detection (writing `contradictsId` by comparing
 * conflicting values across memories) is fuzzy/LLM-territory and is NOT a safe
 * additive win — deferred to a later LLM-assisted pass alongside Context
 * Compiler v2.
 */

export interface ReviewDueInput {
  reviewCadenceDays: number | null;
  /** ISO-8601 or Date; when the memory was last human-confirmed. */
  lastConfirmedAt: string | Date | null;
  /** ISO-8601 or Date; fallback anchor when never confirmed. */
  createdAt: string | Date;
}

/** True when a memory's review cadence has elapsed since it was last affirmed. */
export function isReviewDue(input: ReviewDueInput, now: Date = new Date()): boolean {
  if (input.reviewCadenceDays == null || input.reviewCadenceDays <= 0) return false;
  const anchor = input.lastConfirmedAt ?? input.createdAt;
  const anchorMs = anchor instanceof Date ? anchor.getTime() : new Date(anchor).getTime();
  if (Number.isNaN(anchorMs)) return false;
  const dueMs = anchorMs + input.reviewCadenceDays * 86_400_000;
  return dueMs < now.getTime();
}

/** Days a review-due item is overdue (0 if not due). For sorting/surfacing. */
export function daysOverdue(input: ReviewDueInput, now: Date = new Date()): number {
  if (!isReviewDue(input, now)) return 0;
  const anchor = input.lastConfirmedAt ?? input.createdAt;
  const anchorMs = anchor instanceof Date ? anchor.getTime() : new Date(anchor).getTime();
  const dueMs = anchorMs + (input.reviewCadenceDays ?? 0) * 86_400_000;
  return Math.floor((now.getTime() - dueMs) / 86_400_000);
}
