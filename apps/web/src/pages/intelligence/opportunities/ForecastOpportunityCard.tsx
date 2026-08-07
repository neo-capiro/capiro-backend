import { Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import {
  FORECAST_ACTIONS,
  FORECAST_ACTION_LABELS,
  INBOX_SOURCE_LABELS,
  formatForecastFreshness,
  formatSourceDate,
  type ForecastAction,
  type InboxRow,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * One agency procurement forecast, in the triage inbox.
 *
 * ── The single rule this component exists to enforce ─────────────────────────
 *
 * A forecast is an opportunity to SHAPE, never a solicitation to submit. Four
 * words are therefore banned from everything this card renders unless the
 * provider itself stated them: "open", "solicitation", "eligible", "deadline".
 * That is the phase's own acceptance line, and `ForecastOpportunityCard.test.tsx`
 * asserts it against the rendered text rather than trusting review.
 *
 * The consequences show up in every field:
 *
 *   - the deadline slot says ANTICIPATED AWARD, with the agency named as the
 *     source of the estimate. `InboxRow.responseDeadline` is null for a forecast
 *     and is not read here at all;
 *   - there is no eligibility slot. Not "Unknown" — absent. A forecast is not
 *     something a client can be barred from, so an eligibility row would be
 *     answering a question nobody asked and would read as a determination;
 *   - the actions are Monitor / Assign research / Plan capability briefing /
 *     Pass. Pursue and Submit are absent by construction — see
 *     {@link FORECAST_ACTIONS};
 *   - freshness is stated on the card itself, not only in the page strip: an
 *     agency revises a forecast quietly, so "last observed 6 Aug" is the
 *     reader's only cue that a Shape-now might be acting on a withdrawn plan.
 *
 * ── Why the recommendation can be absent ─────────────────────────────────────
 *
 * The inbox row carries no recommendation — the API recomputes one only on the
 * forecast READ (the drawer/detail). So the card shows the persisted relevance
 * score when there is one and says "Not scored yet" when there is not, and the
 * reader gets the full recommendation by opening the record. Rendering a
 * fabricated "Monitor" here would be a machine judgement nothing computed.
 */
export function ForecastOpportunityCard({
  row,
  onSelectClient,
  onOpenDetail,
  onAction,
}: {
  row: InboxRow;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
  /**
   * Optional. When absent the four actions are not rendered at all rather than
   * rendered inert — a disabled button that never becomes enabled is a promise
   * the surface does not keep.
   */
  onAction?: (action: ForecastAction) => void;
}) {
  const facts = row.forecast;

  return (
    <Card size="small" className="fo-card fo-card--forecast" data-testid={`fo-forecast-row-${row.id}`}>
      <div className="fo-inbox-row__head">
        <Space size={6} wrap>
          <Button
            type="link"
            size="small"
            className="fo-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </Button>
          {/*
            The label carries BOTH facts — where it came from and what it is.
            "Agency forecast" alone can be read as something to bid on.
          */}
          <Tooltip title="An agency's own statement of what it expects to buy. Not a solicitation, and not a competition anybody can respond to yet.">
            <Tag color="gold" data-testid="fo-forecast-label">
              {INBOX_SOURCE_LABELS.agency_forecast}
            </Tag>
          </Tooltip>
          {row.humanDecision ? (
            <Tag data-testid="fo-forecast-decision">Decided: {row.humanDecision}</Tag>
          ) : null}
          {/*
            `isActive === false` is the ONE thing that lets this card say the
            agency stopped: it is the provider's own flag. `null` says nothing,
            and is rendered as nothing — never as "open".
          */}
          {facts?.isActive === false ? (
            <Tooltip title="The agency has marked this forecast inactive. Kept for reference; it is not something to shape now.">
              <Tag color="red" data-testid="fo-forecast-inactive">
                Withdrawn by the agency
              </Tag>
            </Tooltip>
          ) : null}
          {facts?.status ? (
            <Tooltip title="The agency's own status word, verbatim.">
              <Tag data-testid="fo-forecast-status">{facts.status}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      </div>

      <div className="fo-card__title">
        <Button
          type="link"
          className="fo-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open agency forecast detail for ${row.title}`}
        >
          {row.title}
        </Button>
      </div>
      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }}>
          {row.agency ?? 'Agency not stated'}
          {facts?.sourceSystem ? ` · via ${facts.sourceSystem}` : ''}
        </Text>
      </div>

      <div className="fo-card__facts">
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Anticipated award
          </Text>
          {/*
            NOT a deadline, and the label says so. The agency's own estimate,
            attributed to the agency in the tooltip so nobody reads it as a date
            Capiro is asserting.
          */}
          <Tooltip title="The agency's own rough estimate of when it expects to award. It is not a response deadline — there is nothing to respond to yet.">
            <Text className="fo-fact__value" data-testid="fo-forecast-award-date">
              {formatSourceDate(facts?.anticipatedAwardDate ?? null, 'Not stated by the agency')}
            </Text>
          </Tooltip>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Anticipated solicitation
          </Text>
          {/*
            ALWAYS "Not provided by the source". Stated rather than omitted,
            because the reader was told to expect it and a missing row reads as
            "there will not be one".
          */}
          <Text className="fo-fact__value" data-testid="fo-forecast-solicitation-date">
            {facts?.anticipatedSolicitationDate == null
              ? 'Not provided by the source'
              : formatSourceDate(facts.anticipatedSolicitationDate)}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Estimated period
          </Text>
          <Text className="fo-fact__value">{facts?.estimatedPeriod ?? 'Not stated'}</Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Fiscal year
          </Text>
          <Text className="fo-fact__value">{facts?.fiscalYear ?? 'Not stated'}</Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Relevance
          </Text>
          {/*
            "Not scored yet" and a score of 0 are different facts. The full
            recommendation, with its evidence and its confidence band, is
            computed on the forecast read and shown in the detail.
          */}
          <Text className="fo-fact__value" data-testid="fo-forecast-relevance">
            {row.relevanceScore ?? 'Not scored yet'}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Owner
          </Text>
          <Text className="fo-fact__value">
            {row.owner?.name ?? row.owner?.email ?? 'Unassigned'}
          </Text>
        </span>
      </div>

      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 11 }} data-testid="fo-forecast-freshness">
          {facts
            ? formatForecastFreshness(facts)
            : 'Capiro no longer holds this forecast record, so no source facts can be shown.'}
        </Text>
      </div>

      {onAction ? (
        <div className="fo-card__actions" data-testid="fo-forecast-actions">
          <Space size={6} wrap>
            {FORECAST_ACTIONS.map((action) => (
              <Button key={action} size="small" onClick={() => onAction(action)}>
                {FORECAST_ACTION_LABELS[action]}
              </Button>
            ))}
          </Space>
        </div>
      ) : null}
    </Card>
  );
}
