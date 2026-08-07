import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Card, Space, Tag, Tooltip, Typography } from 'antd';
import {
  RECOMMENDATION_COLORS,
  RECOMMENDATION_LABELS,
  type FundingOpportunity,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * The executive assessment, and the isolation that keeps it readable (P32).
 *
 * ── Why a section needs a boundary ───────────────────────────────────────────
 *
 * The detail surface is now eight sections fed by five different endpoints: the
 * opportunity itself, the timeline (P28), the requirements (P31), the
 * acquisition position (P23, inline) and the forecast read (P26). Four of those
 * are SECONDARY — a reader can decide without them — and one is not.
 *
 * Before this phase, a render error inside any of them took the whole drawer
 * with it, because React unmounts the nearest boundary and there was none. The
 * result would be a blank panel where an executive recommendation should be:
 * the reader is told nothing, and has no way to tell "the recommendation is
 * pass" from "the page broke".
 *
 * {@link DetailSectionBoundary} is that boundary, one per section. A section
 * that throws is replaced by a named failure IN ITS OWN CARD, and every other
 * section renders. That is this phase's acceptance line — "one secondary section
 * does not blank the assessment" — enforced structurally rather than by hoping
 * no section throws.
 *
 * A boundary is deliberately NOT put around the whole drawer. One boundary at
 * the top would satisfy React and defeat the purpose: the first throw would
 * still blank everything.
 */

interface BoundaryProps {
  /** Shown in the failure card, so a reader knows WHICH section failed. */
  title: string;
  testId: string;
  /**
   * True for the one section a reader cannot decide without. A primary failure
   * says so loudly; a secondary one says "this section is unavailable, the rest
   * of the assessment stands".
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
    console.error(`[funding-opportunities] section "${this.props.title}" failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Card
        size="small"
        title={this.props.title}
        className="fo-detail__section"
        data-testid={`${this.props.testId}-failed`}
      >
        <Alert
          type={this.props.primary ? 'error' : 'warning'}
          showIcon
          message={`${this.props.title} could not be displayed`}
          description={
            this.props.primary
              ? 'This is a rendering failure, not a finding. No conclusion about this opportunity follows from it.'
              : 'This section could not be displayed. It is a rendering failure, not a finding — the rest of the assessment below is unaffected, and nothing here says anything about the opportunity.'
          }
        />
      </Card>
    );
  }
}

/**
 * Section 1: the executive recommendation.
 *
 * Extracted from `FundingOpportunityDetail`'s inline block so the CARD and the
 * DETAIL read the same fields from the same place. The two used to compose the
 * recommendation independently, which is how a card can say "Pursue" while the
 * drawer says "Needs review" about the same row — the parity this phase's
 * acceptance bar asks for is easier to keep when there is one renderer.
 *
 * ── What this panel will not do ──────────────────────────────────────────────
 *
 * Render an absent recommendation as anything other than absent. A null
 * recommendation has two causes and they get different sentences: no client
 * (nothing to recommend relative to) and no computation (the record has none
 * yet). Neither is "pass".
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
    <Card
      size="small"
      title="Executive assessment"
      className="fo-detail__section"
      data-testid="fo-detail-assessment"
    >
      {recommendation ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Space size={6} wrap>
            <Tag
              color={RECOMMENDATION_COLORS[recommendation.machineRecommendation]}
              data-testid="fo-detail-recommendation"
            >
              {RECOMMENDATION_LABELS[recommendation.machineRecommendation]}
            </Tag>
            {/*
              Evidence quality, NOT a probability of winning. A high-confidence
              `pass` is a confident recommendation not to bid — rendering it as a
              win rate would be the single most misleading thing here.
            */}
            <Tooltip title="How good the evidence is — NOT a probability of winning.">
              <Tag>Confidence: {recommendation.recommendationConfidence}</Tag>
            </Tooltip>
          </Space>
          <Fact label="Why" value={recommendation.primaryReason} />
          <Fact
            label="Main risk"
            value={recommendation.primaryRisk ?? 'No specific risk identified.'}
          />
          <Fact label="Recommended next action" value={recommendation.recommendedNextAction} />
        </Space>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {unscored
            ? 'Not calculated without a client. The recommendation is a fact about a client-opportunity pair, not about the notice.'
            : 'Not yet available for this record. This is an absence of a recommendation, not a recommendation to pass.'}
        </Text>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text type="secondary" className="fo-fact__label">
        {label}
      </Text>
      <div>
        <Text>{value}</Text>
      </div>
    </div>
  );
}
