import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  FORECAST_ACTIONS,
  FORECAST_ACTION_LABELS,
  FORECAST_RECOMMENDATION_COLORS,
  FORECAST_RECOMMENDATION_LABELS,
  INBOX_SOURCE_LABELS,
  forecastDetailApiPath,
  formatForecastFreshness,
  formatSourceDate,
  type ForecastAction,
  type ForecastOpportunityRecord,
  type ForecastRecommendation,
  type ForecastSignalEvidence,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

/**
 * The agency-forecast detail body — vNext port of the canonical
 * ForecastOpportunityDetail.
 *
 * Still a separate component from FundingOpportunityDetail because the two
 * records are different shapes: a forecast has no response deadline, no
 * eligibility determination and no money figure, and rendering it through the
 * opportunity body would mean inventing those or rendering "Unknown" against
 * questions that do not apply.
 *
 * "Not provided by the source" and "not yet available in Capiro" are different
 * sentences and are never interchanged. Neither renders as blank, zero, or a
 * negative.
 */
export function ForecastOpportunityDetail({
  forecastId,
  clientId,
  onAction,
}: {
  forecastId: string;
  clientId: string | null;
  onAction?: (action: ForecastAction) => void;
}) {
  const api = useApi();

  const query = useQuery<ForecastOpportunityRecord>({
    queryKey: ['funding-opportunity-forecast', forecastId, clientId],
    queryFn: async () =>
      (await api.get<ForecastOpportunityRecord>(forecastDetailApiPath(forecastId, clientId))).data,
    retry: false,
  });

  if (query.isPending) {
    return (
      <div data-testid="fo-forecast-detail-loading">
        <FovSkeletonRows rows={8} />
      </div>
    );
  }

  if (query.isError) {
    // 404 and "the request failed" get different copy: "no such forecast" on a
    // network blip would tell somebody an agency had dropped a plan it still
    // holds.
    const status = (query.error as { response?: { status?: number } } | undefined)?.response?.status;
    const notFound = status === 404;
    return (
      <div data-testid={notFound ? 'fo-forecast-not-found' : 'fo-forecast-error'}>
        <FovAlert
          tone={notFound ? 'warning' : 'error'}
          message={notFound ? 'No such agency forecast' : 'The agency forecast failed to load'}
          description={
            notFound
              ? 'Capiro holds no forecast with this id. The link may be stale, the agency may have removed the record, or agency forecasts may not be enabled for this workspace.'
              : 'This is a request failure, not an empty record. Nothing can be concluded about the forecast from it.'
          }
          action={
            notFound ? null : (
              <CapiroButton size="compact" onClick={() => void query.refetch()}>
                Retry
              </CapiroButton>
            )
          }
        />
      </div>
    );
  }

  const f = query.data;
  const unscored = f.clientId == null;

  return (
    <div className="fov fov-detail fov-detail--forecast" data-testid="fo-forecast-detail">
      <header className="fov-detail__head">
        <span className="fov-row">
          <FovPill
            tone="gold"
            title="An agency's own statement of what it expects to buy. Not a solicitation, and not a competition anybody can respond to yet."
          >
            {INBOX_SOURCE_LABELS.agency_forecast}
          </FovPill>
          {f.facts.isActive === false ? <FovPill tone="red">Withdrawn by the agency</FovPill> : null}
          {f.facts.status ? <FovPill>{f.facts.status}</FovPill> : null}
        </span>
        <h2 className="fov-page__title" style={{ margin: '6px 0 2px' }}>
          {f.title}
        </h2>
        <span className="fov-muted">
          {[f.agency, f.departmentName, f.organizationAgencyName, f.officeName]
            .filter(Boolean)
            .join(' · ') || 'Agency not stated'}
          {f.externalId ? ` · ${f.externalId}` : ''}
        </span>
      </header>

      {unscored ? (
        <FovAlert
          tone="info"
          testId="fo-forecast-unscored"
          message="Showing the agency's record only"
          description="No client is selected, so fit and the early-signal recommendation are not calculated. Open this from a client's inbox row to see them."
        />
      ) : null}

      {/* 1 ─ Early-signal assessment */}
      <FovCard title="Early-signal assessment" testId="fo-forecast-assessment">
        {f.recommendation ? (
          <div className="fov-stack fov-stack--6">
            <span className="fov-row">
              <FovPill
                tone={
                  FORECAST_RECOMMENDATION_COLORS[
                    f.recommendation.forecastRecommendation as ForecastRecommendation
                  ]
                }
                testId="fo-forecast-recommendation"
              >
                {FORECAST_RECOMMENDATION_LABELS[
                  f.recommendation.forecastRecommendation as ForecastRecommendation
                ] ?? f.recommendation.forecastRecommendation}
              </FovPill>
              {/* Evidence quality — NOT a probability that the forecast
                  becomes a real solicitation. */}
              <FovPill
                testId="fo-forecast-confidence"
                title="How good the evidence is. NOT a probability of winning, and NOT a probability that this forecast becomes a real solicitation."
              >
                Confidence: {f.recommendation.recommendationConfidence}
              </FovPill>
            </span>
            <div>
              <span className="fov-fact__label">Why</span>
              <div>{f.recommendation.primaryReason}</div>
            </div>
            <div>
              <span className="fov-fact__label">Main risk</span>
              <div>{f.recommendation.primaryRisk ?? 'No specific risk identified.'}</div>
            </div>
            <div>
              <span className="fov-fact__label">Recommended next step</span>
              <div data-testid="fo-forecast-next-action">
                {f.recommendation.recommendedNextAction}
              </div>
            </div>
          </div>
        ) : (
          <span className="fov-muted">
            {unscored
              ? 'Not calculated without a client. Fit is a fact about a client-forecast pair, not about the agency’s plan.'
              : 'Not calculated: this client has no profile record to judge fit against.'}
          </span>
        )}
      </FovCard>

      {/* 2 ─ Evidence, including what could not be evaluated */}
      <FovCard title="Evidence" testId="fo-forecast-evidence">
        {f.recommendation ? (
          <>
            <div className="fov-stack fov-stack--2">
              {SIGNAL_LABELS.map(([key, label]) => {
                const unavailable = f.recommendation!.signals.unavailable.find(
                  (u) => u.signal === key,
                );
                const established = f.recommendation!.signals[key];
                return (
                  <div key={key} data-testid={`fo-forecast-signal-${key}`}>
                    {unavailable ? (
                      // NOT an unticked box. "Could not be evaluated" is a fact
                      // about the data; rendering it as false would state an
                      // absence of the client's fit instead.
                      <FovPill title={unavailable.reason}>{label}: not evaluated</FovPill>
                    ) : (
                      <FovPill tone={established ? 'green' : 'default'}>
                        {label}: {established ? 'yes' : 'no match'}
                      </FovPill>
                    )}
                  </div>
                );
              })}
            </div>
            {f.missingProfileFields.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <span className="fov-micro">
                  Better matching needs:{' '}
                  {f.missingProfileFields.map((m, i) => (
                    <span key={m.field}>
                      {i > 0 ? ', ' : ''}
                      {m.href ? (
                        <a href={m.href} title={m.impact}>
                          {m.label}
                        </a>
                      ) : (
                        <span title={m.impact}>{m.label}</span>
                      )}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <span className="fov-muted">
            No signals were evaluated, so nothing here says anything about this client’s fit.
          </span>
        )}
      </FovCard>

      {/* 3 ─ What happens next: the linkage gap, stated as a gap */}
      <FovCard title="What happens next" testId="fo-forecast-linkage">
        <p className="fov-muted" style={{ margin: '0 0 6px' }}>
          {/* Stated as a gap in Capiro, not as a fact about the agency: "no
              solicitation followed" is a claim nobody can make from this
              record. */}
          Capiro does not yet link a forecast to the solicitation it becomes.{' '}
          {f.linkedOpportunity == null ? 'Nothing is linked to this record.' : null} That is an
          absence of a link, not evidence that no solicitation followed — the only honest way to
          make the link is an exact identifier the agency does not publish on this record, and
          inferring one from the title text is the kind of guess this system does not make.
        </p>
        <span className="fov-muted">
          Until then: watch for a matching notice on the SAM.gov rail, and keep any decision you
          record here — it stays attached to the forecast even after a real notice appears.
        </span>
      </FovCard>

      {/* 4 ─ Team plan */}
      <FovCard title="Team plan" testId="fo-forecast-plan">
        <div className="fov-card__facts">
          <span className="fov-fact">
            <span className="fov-fact__label">Team decision</span>
            <span className="fov-fact__value">
              {f.decision ? f.decision.decision : 'No decision recorded'}
            </span>
          </span>
          <span className="fov-fact">
            <span className="fov-fact__label">Workflow stage</span>
            <span className="fov-fact__value">{f.workflow?.status ?? 'Not started'}</span>
          </span>
          <span className="fov-fact">
            <span className="fov-fact__label">Next action</span>
            <span className="fov-fact__value">{f.decision?.nextAction ?? 'None recorded'}</span>
          </span>
          <span className="fov-fact">
            <span className="fov-fact__label">Next action due</span>
            <span className="fov-fact__value">
              {f.decision?.nextActionDueAt
                ? new Date(f.decision.nextActionDueAt).toLocaleDateString()
                : 'No date'}
            </span>
          </span>
        </div>
        {f.decision?.reason ? (
          <p className="fov-muted" style={{ margin: 0 }}>
            Reason given: {f.decision.reason}
          </p>
        ) : null}
        {onAction ? (
          <div className="fov-card__actions" data-testid="fo-forecast-detail-actions">
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

      {/* 5 ─ Source record */}
      <FovCard title="Source record" testId="fo-forecast-source">
        <div className="fov-desc-wrap">
          <table className="fov-desc">
            <tbody>
              <DescRow label="Source">{INBOX_SOURCE_LABELS.agency_forecast}</DescRow>
              <DescRow label="Agency system">{f.facts.sourceSystem ?? notProvided()}</DescRow>
              <DescRow label="Provider record id">{f.sourceRecordId}</DescRow>
              <DescRow label="Agency’s own id">{f.externalId ?? notProvided()}</DescRow>
              <DescRow label="Anticipated award">
                {formatSourceDate(f.facts.anticipatedAwardDate, 'Not stated by the agency')}
              </DescRow>
              <DescRow label="Anticipated solicitation">
                {/* Always this sentence: the resource carries no such field at all. */}
                {notProvided()}
              </DescRow>
              <DescRow label="Estimated period">{f.facts.estimatedPeriod ?? notProvided()}</DescRow>
              <DescRow label="Fiscal year">{f.facts.fiscalYear ?? notProvided()}</DescRow>
              <DescRow label="NAICS">{f.naicsCode ?? notProvided()}</DescRow>
              <DescRow label="PSC">{f.pscCode ?? notProvided()}</DescRow>
              <DescRow label="Set-aside">{f.setAside ?? notProvided()}</DescRow>
              <DescRow label="Contract vehicle">{f.contractVehicle ?? notProvided()}</DescRow>
              <DescRow label="Place of performance">{f.placeOfPerformance ?? notProvided()}</DescRow>
              <DescRow label="Agency contact">
                {f.primaryContact
                  ? [
                      f.primaryContact.name,
                      f.primaryContact.title,
                      f.primaryContact.email,
                      f.primaryContact.phone,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : notProvided()}
              </DescRow>
              <DescRow label="Freshness">
                <span data-testid="fo-forecast-detail-freshness">
                  {formatForecastFreshness(f.facts)}
                </span>
              </DescRow>
            </tbody>
          </table>
        </div>
        {f.description ? (
          <p className="fov-muted" style={{ margin: '10px 0 0' }}>
            {/* Untrusted source text. Rendered as prose, never interpreted — an
                instruction inside an agency description is data, not a command. */}
            {f.description}
          </p>
        ) : (
          <p className="fov-muted" style={{ margin: '10px 0 0' }}>
            The agency provides no description for this record.
          </p>
        )}
      </FovCard>
    </div>
  );
}

function DescRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  );
}

/** A SOURCE absence — a fact about the agency's record, not about Capiro. */
function notProvided() {
  return <span className="fov-muted">Not provided by the source</span>;
}

/**
 * The signal rows, in the order the evidence panel lists them.
 *
 * Strongest-first, matching `forecast-relevance.ts`'s own rule order: the four
 * that can produce `shape_now` on their own come before the three that can only
 * ever support a `monitor`.
 */
const SIGNAL_LABELS: Array<[keyof Omit<ForecastSignalEvidence, 'unavailable'>, string]> = [
  ['exactNaicsMatch', 'Exact NAICS match'],
  ['exactPscMatch', 'Exact PSC match'],
  ['capabilityMatch', 'Recorded capability match'],
  ['programElementLinkedSourceBacked', 'Program Element named in the record'],
  ['priorAgencyHistory', 'Prior award history with this agency'],
  ['knownVehicleAccess', 'Known contract-vehicle access'],
  ['locationMatch', 'Client facility in a named state'],
  ['reviewedStrategicPriority', 'Reviewed strategic priority'],
];
