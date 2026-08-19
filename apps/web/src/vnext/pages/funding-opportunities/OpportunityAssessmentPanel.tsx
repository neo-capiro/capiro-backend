import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
  RECOMMENDATION_COLORS,
  RECOMMENDATION_LABELS,
  type FundingOpportunity,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill } from './fov-ui.js';

/**
 * The executive assessment, and the per-section isolation — vNext port of the
 * canonical OpportunityAssessmentPanel/DetailSectionBoundary (P32).
 *
 * The boundary contract is unchanged: one boundary PER SECTION, never one
 * around the whole body — a section that throws is replaced by a named failure
 * in its own card, and every other section renders.
 */

interface BoundaryProps {
  /** Shown in the failure card, so a reader knows WHICH section failed. */
  title: string;
  testId: string;
  /**
   * True for the one section a reader cannot decide without. A primary failure
   * says so loudly; a secondary one says the rest of the assessment stands.
   */
  primary?: boolean;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

export class DetailSectionBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged, never rendered. A stack trace in the page tells a reader nothing
    // and may quote source content the surrounding phases treat as untrusted.
    // eslint-disable-next-line no-console
    console.error(
      `[funding-opportunities] section "${this.props.title}" failed to render`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <FovCard title={this.props.title} testId={`${this.props.testId}-failed`}>
        <FovAlert
          tone={this.props.primary ? 'error' : 'warning'}
          message={`${this.props.title} could not be displayed`}
          description={
            this.props.primary
              ? 'This is a rendering failure, not a finding. No conclusion about this opportunity follows from it.'
              : 'This section could not be displayed. It is a rendering failure, not a finding — the rest of the assessment below is unaffected, and nothing here says anything about the opportunity.'
          }
        />
      </FovCard>
    );
  }
}

/**
 * Section 1: the executive recommendation. One renderer for card and detail —
 * a null recommendation has two causes and they get different sentences: no
 * client (nothing to recommend relative to) and no computation (the record has
 * none yet). Neither is "pass".
 */
export function OpportunityAssessmentPanel({
  opportunity,
  unscored,
}: {
  opportunity: FundingOpportunity;
  /** True on the catalog read, where there is no client to score against. */
  unscored: boolean;
}) {
  const recommendation = opportunity.recommendation;

  return (
    <FovCard title="Executive assessment" testId="fo-detail-assessment">
      {recommendation ? (
        <div className="fov-stack fov-stack--6">
          <span className="fov-row">
            <FovPill
              tone={RECOMMENDATION_COLORS[recommendation.machineRecommendation]}
              testId="fo-detail-recommendation"
            >
              {RECOMMENDATION_LABELS[recommendation.machineRecommendation]}
            </FovPill>
            {/* Evidence quality, NOT a probability of winning. */}
            <FovPill title="How good the evidence is — NOT a probability of winning.">
              Confidence: {recommendation.recommendationConfidence}
            </FovPill>
          </span>
          <Fact label="Why" value={recommendation.primaryReason} />
          <Fact
            label="Main risk"
            value={recommendation.primaryRisk ?? 'No specific risk identified.'}
          />
          <Fact label="Recommended next action" value={recommendation.recommendedNextAction} />
        </div>
      ) : (
        <span className="fov-muted">
          {unscored
            ? 'Not calculated without a client. The recommendation is a fact about a client-opportunity pair, not about the notice.'
            : 'Not yet available for this record. This is an absence of a recommendation, not a recommendation to pass.'}
        </span>
      )}
    </FovCard>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="fov-fact__label">{label}</span>
      <div>{value}</div>
    </div>
  );
}
