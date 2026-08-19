import { CapiroButton } from '../../components/actions/index.js';
import {
  FORECAST_ACTIONS,
  FORECAST_ACTION_LABELS,
  INBOX_SOURCE_LABELS,
  formatForecastFreshness,
  formatSourceDate,
  type ForecastAction,
  type InboxRow,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovCard, FovPill } from './fov-ui.js';

/**
 * One agency procurement forecast, in the triage inbox — vNext port of the
 * canonical ForecastOpportunityCard.
 *
 * The single rule is unchanged: a forecast is an opportunity to SHAPE, never a
 * solicitation to submit. Four words stay banned from everything this card
 * renders unless the provider itself stated them: "open", "solicitation",
 * "eligible", "deadline". Consequences, verbatim from canonical:
 *
 *   - the deadline slot says ANTICIPATED AWARD, attributed to the agency;
 *     `InboxRow.responseDeadline` is not read here at all;
 *   - there is no eligibility slot. Not "Unknown" — absent;
 *   - the actions are Monitor / Assign research / Plan capability briefing /
 *     Pass. Pursue and Submit are absent by construction;
 *   - freshness is stated on the card itself, not only in the page strip.
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
    <FovCard className="fov-card--forecast" testId={`fo-forecast-row-${row.id}`}>
      <div className="fov-inbox-row__head">
        <span className="fov-row">
          <button
            type="button"
            className="fov-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </button>
          {/* The label carries BOTH facts — where it came from and what it is. */}
          <FovPill
            tone="gold"
            testId="fo-forecast-label"
            title="An agency's own statement of what it expects to buy. Not a solicitation, and not a competition anybody can respond to yet."
          >
            {INBOX_SOURCE_LABELS.agency_forecast}
          </FovPill>
          {row.humanDecision ? (
            <FovPill testId="fo-forecast-decision">Decided: {row.humanDecision}</FovPill>
          ) : null}
          {/* `isActive === false` is the ONE thing that lets this card say the
              agency stopped: it is the provider's own flag. `null` says
              nothing, and is rendered as nothing — never as "open". */}
          {facts?.isActive === false ? (
            <FovPill
              tone="red"
              testId="fo-forecast-inactive"
              title="The agency has marked this forecast inactive. Kept for reference; it is not something to shape now."
            >
              Withdrawn by the agency
            </FovPill>
          ) : null}
          {facts?.status ? (
            <FovPill testId="fo-forecast-status" title="The agency's own status word, verbatim.">
              {facts.status}
            </FovPill>
          ) : null}
        </span>
      </div>

      <div className="fov-card__title">
        <button
          type="button"
          className="fov-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open agency forecast detail for ${row.title}`}
        >
          {row.title}
        </button>
      </div>
      <div className="fov-card__meta">
        <span className="fov-muted">
          {row.agency ?? 'Agency not stated'}
          {facts?.sourceSystem ? ` · via ${facts.sourceSystem}` : ''}
        </span>
      </div>

      <div className="fov-card__facts">
        <span className="fov-fact">
          <span className="fov-fact__label">Anticipated award</span>
          {/* NOT a deadline, and the label says so. */}
          <span
            className="fov-fact__value"
            data-testid="fo-forecast-award-date"
            title="The agency's own rough estimate of when it expects to award. It is not a response deadline — there is nothing to respond to yet."
          >
            {formatSourceDate(facts?.anticipatedAwardDate ?? null, 'Not stated by the agency')}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Anticipated solicitation</span>
          {/* ALWAYS "Not provided by the source" when absent. Stated rather
              than omitted: a missing row reads as "there will not be one". */}
          <span className="fov-fact__value" data-testid="fo-forecast-solicitation-date">
            {facts?.anticipatedSolicitationDate == null
              ? 'Not provided by the source'
              : formatSourceDate(facts.anticipatedSolicitationDate)}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Estimated period</span>
          <span className="fov-fact__value">{facts?.estimatedPeriod ?? 'Not stated'}</span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Fiscal year</span>
          <span className="fov-fact__value">{facts?.fiscalYear ?? 'Not stated'}</span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Relevance</span>
          {/* "Not scored yet" and a score of 0 are different facts. */}
          <span className="fov-fact__value" data-testid="fo-forecast-relevance">
            {row.relevanceScore ?? 'Not scored yet'}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Owner</span>
          <span className="fov-fact__value">
            {row.owner?.name ?? row.owner?.email ?? 'Unassigned'}
          </span>
        </span>
      </div>

      <div className="fov-card__meta">
        <span className="fov-micro" data-testid="fo-forecast-freshness">
          {facts
            ? formatForecastFreshness(facts)
            : 'Capiro no longer holds this forecast record, so no source facts can be shown.'}
        </span>
      </div>

      {onAction ? (
        <div className="fov-card__actions" data-testid="fo-forecast-actions">
          <span className="fov-row">
            {FORECAST_ACTIONS.map((action) => (
              <CapiroButton key={action} size="compact" onClick={() => onAction(action)}>
                {FORECAST_ACTION_LABELS[action]}
              </CapiroButton>
            ))}
          </span>
        </div>
      ) : null}
    </FovCard>
  );
}
