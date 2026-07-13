/**
 * Web-side mirror of the G4 reviews API contract
 * (`apps/api/src/reviews/reviews.controller.ts` + `reviews.service.ts`). The web
 * tree cannot import server code, so the unions/interface are re-declared here;
 * keep them BYTE-FOR-BYTE in step with the API. `RiskTier` is the ONE shared
 * type (it lives in `@capiro/shared`), so it is imported rather than re-declared.
 */
import type { RiskTier } from '@capiro/shared';

export type { RiskTier };

/** The held-deliverable surfaces that emit a review (server ReviewSurface). */
export type ReviewSurface = 'alert-memo' | 'district-brief' | 'research';

/** Lifecycle of a review request. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/**
 * One row from GET /api/reviews. NB: the list projection deliberately omits
 * `payload` (the held content) — a detail endpoint would be needed for that, so
 * the "proposed memory / diff" panels are out of scope here. Nullable fields are
 * typed defensively; the UI must never crash on missing data.
 */
export interface ReviewRequestDto {
  id: string;
  riskTier: RiskTier;
  surface: ReviewSurface;
  subjectType: string;
  subjectId: string | null;
  clientId: string | null;
  title: string;
  reason: string;
  status: ReviewStatus;
  requestedBy: string | null;
  assignedTo: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** What approve() returns — released deliverable pointer (shape varies by surface). */
export interface ApproveResult {
  ok: boolean;
  id: string;
  released?: {
    attachmentId?: string;
    fileName?: string;
    artifactId?: string;
    heldForReview?: boolean;
  } | null;
}

export const SURFACE_LABELS: Record<ReviewSurface, string> = {
  'alert-memo': 'Alert memo',
  'district-brief': 'District brief',
  research: 'Research',
};

export const RISK_TIER_LABELS: Record<RiskTier, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  restricted: 'Restricted',
};

export const RISK_TIER_COLORS: Record<RiskTier, string> = {
  low: 'green',
  moderate: 'gold',
  high: 'orange',
  restricted: 'red',
};

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const STATUS_COLORS: Record<ReviewStatus, string> = {
  pending: 'blue',
  approved: 'green',
  rejected: 'default',
};
