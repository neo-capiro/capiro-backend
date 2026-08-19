import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FIT_BAND_COLORS,
  FIT_BAND_LABELS,
  explainSignals,
} from '../../../pages/intelligence/opportunities/opportunity-explanations.js';
import {
  DIBBS_NO_DETAIL_DESCRIPTION,
  DIBBS_NO_DETAIL_MESSAGE,
  DIBBS_SOURCE,
  SBIR_NO_DETAIL_DESCRIPTION,
  SBIR_NO_DETAIL_MESSAGE,
  SBIR_SOURCE,
  ELIGIBILITY_LABELS,
  FORECAST_SOURCE,
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  KIND_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  isOpportunitySource,
  moneyLine,
  type CatalogOpportunityRef,
  type FundingOpportunity,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { AcquisitionPositionPanel } from './AcquisitionPositionPanel.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import { GovernmentLandscapePanel } from './GovernmentLandscapePanel.js';
import { MeriOpportunityAssessment } from './MeriOpportunityAssessment.js';
import { OpportunityActionPlan } from './OpportunityActionPlan.js';
import { OpportunityBudgetContext } from './OpportunityBudgetContext.js';
import { OpportunityRequirementsPanel } from './OpportunityRequirementsPanel.js';
import { OpportunityRiskPanel } from './OpportunityRiskPanel.js';
import { OpportunityTimeline } from './OpportunityTimeline.js';
import { DetailSectionBoundary, OpportunityAssessmentPanel } from './OpportunityAssessmentPanel.js';
import { FovAlert, FovCard, FovFact, FovPill, FovSkeletonRows } from './fov-ui.js';
import './funding-opportunities-vnext.css';

/**
 * The opportunity detail surface — vNext port of the canonical
 * FundingOpportunityDetail (one body, two frames: the drawer and the full page
 * render THIS, unmodified, so the two can never drift into showing different
 * facts about the same record).
 *
 * Every empty section keeps its two-kinds-of-absence rule: "Not yet available"
 * is a product gap, "Not provided" is a source fact, and neither renders as
 * blank or as a negative.
 */

function sourceValue(value: string | null | undefined): ReactNode {
  return value && value.trim() ? value : <span className="fov-muted">Not provided</span>;
}

function DescRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  );
}

export function FundingOpportunityDetail({ refValue }: { refValue: CatalogOpportunityRef }) {
  const api = useApi();
  const { source, sourceRecordId, clientId } = refValue;

  const query = useQuery<FundingOpportunity>({
    queryKey: ['funding-opportunity-detail', source, sourceRecordId, clientId],
    queryFn: async () => {
      const suffix = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
      const url = `/api/intelligence/opportunities/${source}/${encodeURIComponent(sourceRecordId)}${suffix}`;
      return (await api.get<FundingOpportunity>(url)).data;
    },
    retry: false,
  });

  if (query.isPending) {
    return (
      <div data-testid="fo-detail-loading">
        <FovSkeletonRows rows={10} />
      </div>
    );
  }

  if (query.isError) {
    // 404 and "the request failed" are different states and get different
    // copy. "Not found" on a network blip would tell somebody a live
    // solicitation had been withdrawn.
    const status = (query.error as { response?: { status?: number } } | undefined)?.response?.status;
    const notFound = status === 404;
    return (
      <div data-testid={notFound ? 'fo-detail-not-found' : 'fo-detail-error'}>
        <FovAlert
          tone={notFound ? 'warning' : 'error'}
          message={notFound ? 'No such opportunity' : 'The opportunity failed to load'}
          description={
            notFound
              ? `Nothing in the ${SOURCE_LABELS[source] ?? source} catalog matches this record id. The link may be stale, or the record may have been removed from the source.`
              : 'This is a request failure, not an empty record. Nothing can be concluded about the opportunity from it.'
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

  const o = query.data;
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const money = moneyLine(o);
  const explained = explainSignals(o.matchedSignals);
  const unscored = clientId == null;

  return (
    <div className="fov fov-detail" data-testid="fo-detail">
      <header className="fov-detail__head">
        <span className="fov-row">
          <FovPill tone={o.source === 'grants_gov' ? 'purple' : 'cyan'}>
            {SOURCE_LABELS[o.source]}
          </FovPill>
          <FovPill>{KIND_LABELS[o.kind]}</FovPill>
          {o.baseKind && o.baseKind !== o.kind ? (
            <FovPill
              tone="gold"
              title="This notice was originally posted at an earlier stage. It is not an original solicitation."
            >
              Was {KIND_LABELS[o.baseKind]}
            </FovPill>
          ) : null}
          {!o.isPursuable ? <FovPill>Not a pursuit</FovPill> : null}
          {!o.isActive ? <FovPill>Closed</FovPill> : null}
          {o.workflow ? (
            <FovPill tone={o.workflow.status === 'pursuing' ? 'geekblue' : 'default'}>
              {WORKFLOW_LABELS[o.workflow.status]}
            </FovPill>
          ) : null}
        </span>
        <h2 className="fov-page__title" style={{ margin: '6px 0 2px' }}>
          {o.title}
        </h2>
        <span className="fov-muted">
          {[o.agency, o.subAgency, o.office].filter(Boolean).join(' · ') || 'Agency not stated'}
          {o.sourceReference ? ` · ${o.sourceReference}` : ''}
        </span>
      </header>

      {unscored ? (
        <FovAlert
          tone="info"
          testId="fo-detail-unscored"
          message="Showing the source record only"
          description="No client is selected, so relevance, eligibility, the recommendation and any decision are not calculated. Open this from a client's inbox row to see them."
        />
      ) : null}

      {/* 1 ─ Executive assessment (P32). PRIMARY: a reader cannot decide
             without it, so its failure says so loudly. */}
      <DetailSectionBoundary title="Executive assessment" testId="fo-detail-assessment" primary>
        <OpportunityAssessmentPanel opportunity={o} unscored={unscored} />
      </DetailSectionBoundary>

      {/* 2 ─ Fit and eligibility. Two separate concepts, deliberately adjacent
             so the difference is visible rather than merged into one score. */}
      <FovCard title="Fit and eligibility" testId="fo-detail-fit">
        <div className="fov-card__facts">
          <FovFact
            label="Fit"
            value={
              <FovPill tone={FIT_BAND_COLORS[explained.fitBand]}>
                {FIT_BAND_LABELS[explained.fitBand]}
              </FovPill>
            }
          />
          <FovFact
            label="Eligibility"
            value={
              <FovPill title={o.eligibility.reason}>
                {ELIGIBILITY_LABELS[o.eligibility.state]}
              </FovPill>
            }
          />
          <FovFact label="Relevance score" value={unscored ? 'Not calculated' : o.relevanceScore} />
        </div>
        <p className="fov-muted" style={{ margin: '0 0 8px' }}>
          {o.eligibility.reason}
        </p>
        {explained.signals.length > 0 ? (
          <div className="fov-stack fov-stack--2">
            {explained.signals.map((s) => (
              <div key={`${s.signal}:${s.matchedOn}`} className="fov-row">
                <FovPill tone={FIT_BAND_COLORS[s.strength]}>{s.label}</FovPill>
                <span className="fov-micro">matched on “{s.matchedOn}”</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="fov-muted">
            {unscored
              ? 'No client selected, so no signals were evaluated.'
              : 'No matching signals against this client’s recorded profile. That is an absence of evidence, not evidence of a poor fit.'}
          </span>
        )}
        {o.missingProfileFields.length > 0 ? (
          <div className="fov-card__gaps" style={{ marginTop: 8 }}>
            <span className="fov-micro">
              Better matching needs:{' '}
              {o.missingProfileFields.map((f, i) => (
                <span key={f.field}>
                  {i > 0 ? ', ' : ''}
                  {f.href ? (
                    <a href={f.href} title={f.impact}>
                      {f.label}
                    </a>
                  ) : (
                    <span title={f.impact}>{f.label}</span>
                  )}
                </span>
              ))}
            </span>
          </div>
        ) : null}
      </FovCard>

      {/* 3 ─ Acquisition position (P22/P23) */}
      <DetailSectionBoundary title="Acquisition position" testId="fo-detail-acquisition">
        <AcquisitionPositionPanel opportunity={o} />
      </DetailSectionBoundary>

      {/* 4 ─ Government landscape (P33). */}
      <DetailSectionBoundary title="Government landscape" testId="fo-detail-landscape">
        <GovernmentLandscapePanel
          clientId={clientId}
          source={o.source}
          sourceRecordId={o.sourceRecordId}
        />
      </DetailSectionBoundary>

      {/* 5 ─ Action plan (P34). Proposals derived from the same landscape
             packet the section above shows. */}
      <DetailSectionBoundary title="Action plan" testId="fo-detail-action-plan">
        <OpportunityActionPlan
          clientId={clientId}
          source={o.source}
          sourceRecordId={o.sourceRecordId}
          workflowStatus={o.workflow?.status ?? null}
        />
      </DetailSectionBoundary>

      {/* 5b ─ Meri assessment (P38). `conversationId` is null from this
              surface, and the panel renders the honest state for that rather
              than a broken button. */}
      <DetailSectionBoundary title="Meri assessment" testId="fo-detail-meri-assessment-section">
        <MeriOpportunityAssessment
          clientId={clientId}
          conversationId={null}
          source={o.source}
          sourceRecordId={o.sourceRecordId}
        />
      </DetailSectionBoundary>

      {/* 5c ─ Budget beta context (P44). Keyed on the CLIENT, not this notice. */}
      <DetailSectionBoundary title="Federal account execution" testId="fo-detail-budget-section">
        <OpportunityBudgetContext clientId={clientId} />
      </DetailSectionBoundary>

      {/* 5d ─ Procurement risk (P45). Client-keyed, like the budget panel. */}
      <DetailSectionBoundary title="Procurement risk" testId="fo-detail-risk-section">
        <OpportunityRiskPanel clientId={clientId} />
      </DetailSectionBoundary>

      {/* 6 ─ Pursuit plan. Three separate concepts that can legitimately
             disagree, shown as three separate facts. */}
      <FovCard title="Pursuit plan" testId="fo-detail-pursuit">
        <div className="fov-card__facts">
          <FovFact
            label="Team decision"
            value={o.decision ? o.decision.decision : 'No decision recorded'}
          />
          <FovFact
            label="Workflow stage"
            value={o.workflow ? WORKFLOW_LABELS[o.workflow.status] : 'Not started'}
          />
          <FovFact
            label="Owner"
            value={o.workflow?.owner?.name ?? o.workflow?.owner?.email ?? 'Unassigned'}
          />
          <FovFact label="Next action" value={o.decision?.nextAction ?? 'None recorded'} />
          <FovFact
            label="Next action due"
            value={
              o.decision?.nextActionDueAt
                ? new Date(o.decision.nextActionDueAt).toLocaleDateString()
                : 'No date'
            }
          />
        </div>
        {o.decision?.reason ? (
          <p className="fov-muted" style={{ margin: 0 }}>
            Reason given: {o.decision.reason}
          </p>
        ) : null}
        {o.workflow?.notes ? <p style={{ fontSize: 12, margin: 0 }}>{o.workflow.notes}</p> : null}
      </FovCard>

      {/* 7 ─ Timeline. Source dates today; how they CHANGED is the notice
             history below. */}
      <FovCard title="Timeline" testId="fo-detail-timeline">
        <div className="fov-card__facts">
          <FovFact
            label="Posted"
            value={o.postedDate ? new Date(o.postedDate).toLocaleDateString() : 'Not provided'}
          />
          <FovFact
            label="Response deadline"
            value={
              <>
                {deadline.text}
                {deadline.daysRemaining != null && deadline.daysRemaining >= 0 ? (
                  <span
                    className={deadline.daysRemaining <= 14 ? 'fov-danger-text' : 'fov-micro'}
                    style={{ fontSize: 11 }}
                  >
                    {' '}
                    ({deadline.daysRemaining}d)
                  </span>
                ) : null}
              </>
            }
          />
          <FovFact
            label="Closes / archives"
            value={
              o.closeOrArchiveDate
                ? new Date(o.closeOrArchiveDate).toLocaleDateString()
                : 'Not provided'
            }
          />
          <FovFact
            label="Source last updated"
            value={o.sourceUpdatedAt ? new Date(o.sourceUpdatedAt).toLocaleString() : 'Not provided'}
          />
        </div>
        <span className="fov-muted">
          These are the dates the current source record states. How they CHANGED is the notice
          history below.
        </span>
      </FovCard>

      {/* 7b ─ Notice history (P28). */}
      <DetailSectionBoundary title="Notice history" testId="fo-timeline">
        <OpportunityTimeline source={o.source} sourceRecordId={o.sourceRecordId} />
      </DetailSectionBoundary>

      {/* 8 ─ Requirements (P31). */}
      <DetailSectionBoundary title="Requirements" testId="fo-detail-requirements">
        <OpportunityRequirementsPanel source={o.source} sourceRecordId={o.sourceRecordId} />
      </DetailSectionBoundary>

      {/* 9 ─ Source record. Provenance, always, and the link out. */}
      <FovCard title="Source record" testId="fo-detail-source">
        <div className="fov-desc-wrap">
          <table className="fov-desc">
            <tbody>
              <DescRow label="Source">{SOURCE_LABELS[o.source]}</DescRow>
              <DescRow label="Source record id">{o.sourceRecordId}</DescRow>
              <DescRow label="Source reference">{sourceValue(o.sourceReference)}</DescRow>
              <DescRow label="Notice type">
                {KIND_LABELS[o.kind]}
                {o.kindRaw ? ` (source says: ${o.kindRaw})` : ''}
              </DescRow>
              <DescRow label="Status">{sourceValue(o.status)}</DescRow>
              <DescRow label={money.label}>{money.value}</DescRow>
              <DescRow label="Set-aside">{sourceValue(o.setAside)}</DescRow>
              <DescRow label="NAICS">
                {o.naicsCodes.length ? o.naicsCodes.join(', ') : sourceValue(null)}
              </DescRow>
              <DescRow label="PSC">
                {o.pscCodes.length ? o.pscCodes.join(', ') : sourceValue(null)}
              </DescRow>
              <DescRow label="Assistance Listings">
                {o.assistanceListings.length ? o.assistanceListings.join(', ') : sourceValue(null)}
              </DescRow>
              <DescRow label="Place of performance">
                {o.placeOfPerformance
                  ? [
                      o.placeOfPerformance.city,
                      o.placeOfPerformance.state,
                      o.placeOfPerformance.zip,
                      o.placeOfPerformance.country,
                    ]
                      .filter(Boolean)
                      .join(', ') || sourceValue(null)
                  : sourceValue(null)}
              </DescRow>
              <DescRow label="Source URL">
                {o.sourceUrl ? (
                  <a href={o.sourceUrl} target="_blank" rel="noreferrer">
                    {o.sourceUrl} ↗
                  </a>
                ) : (
                  sourceValue(null)
                )}
              </DescRow>
            </tbody>
          </table>
        </div>
        {o.summary ? (
          o.summaryIsLink ? (
            <p style={{ margin: '10px 0 0', fontSize: 12 }}>
              <a href={o.summary} target="_blank" rel="noreferrer">
                Read the full description on SAM.gov ↗
              </a>
            </p>
          ) : (
            <p className="fov-muted" style={{ margin: '10px 0 0' }}>
              {o.summary}
            </p>
          )
        ) : (
          <p className="fov-muted" style={{ margin: '10px 0 0' }}>
            The source provides no description for this record.
          </p>
        )}
      </FovCard>
    </div>
  );
}

/**
 * The full-page frame: the same body, reached by a deep link. Route params
 * rather than props, so this is what VNextFundingOpportunitiesRoutes mounts.
 */
export function FundingOpportunityDetailPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  /**
   * The forecast flag, read here rather than inferred from the URL: a deep
   * link to `agency_forecast/...` in a workspace without the flag must render
   * a NAMED not-enabled state, not the forecast body waiting on a route that
   * will 404 anyway.
   */
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const params = useParams<{ source?: string; sourceRecordId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  if (!ready || !forecasts.ready) {
    return (
      <div className="fov">
        <FovSkeletonRows rows={8} />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="fov">
        <FovAlert
          tone="info"
          message="Funding Opportunities is not enabled for this workspace"
          description="Grants.gov and SAM.gov opportunity matching is available on request."
        />
      </div>
    );
  }

  const source = params.source ?? '';
  const sourceRecordId = params.sourceRecordId ?? '';
  const clientId = searchParams.get('clientId');

  const back = (
    <CapiroButton
      size="compact"
      className="fov-detail__back"
      onClick={() => navigate('/intelligence/opportunities')}
    >
      ← Funding Opportunities
    </CapiroButton>
  );

  // ── Agency forecasts: a different record type, at the same route shape ────
  if (source === FORECAST_SOURCE && sourceRecordId) {
    if (!forecasts.enabled) {
      return (
        <div className="fov" data-testid="fo-forecast-not-enabled">
          <FovAlert
            tone="info"
            message="Agency forecasts are not enabled for this workspace"
            description="Pre-solicitation agency forecasts are a separate capability from Grants.gov and SAM.gov opportunity matching. This link will work once they are turned on; it says nothing about whether the forecast exists."
            action={back}
          />
        </div>
      );
    }
    return (
      <div className="fov">
        {back}
        <ForecastOpportunityDetail forecastId={sourceRecordId} clientId={clientId} />
      </div>
    );
  }

  /*
    ── DLA bid board: a real rail with no detail page yet (P41). Stated as
    itself rather than falling through to the malformed-URL branch, which
    would claim "dibbs" is not a source Capiro holds — false about Capiro's
    own data. ─────────────────────────────────────────────────────────────
  */
  if (source === DIBBS_SOURCE && sourceRecordId) {
    return (
      <div className="fov" data-testid="fo-dibbs-no-detail">
        <FovAlert
          tone="info"
          message={DIBBS_NO_DETAIL_MESSAGE}
          description={DIBBS_NO_DETAIL_DESCRIPTION}
          action={back}
        />
      </div>
    );
  }

  // P43. Same shape, same reason: `sbir_sttr` is a legal inbox source.
  if (source === SBIR_SOURCE && sourceRecordId) {
    return (
      <div className="fov" data-testid="fo-sbir-no-detail">
        <FovAlert
          tone="info"
          message={SBIR_NO_DETAIL_MESSAGE}
          description={SBIR_NO_DETAIL_DESCRIPTION}
          action={back}
        />
      </div>
    );
  }

  // A malformed URL is a NAMED state, not a blank page and not a request.
  if (!isOpportunitySource(source) || !sourceRecordId) {
    return (
      <div className="fov" data-testid="fo-detail-bad-ref">
        <FovAlert
          tone="warning"
          message="That is not a valid opportunity link"
          description={`“${source || 'nothing'}” is not a source Capiro holds. Valid sources are grants_gov, sam_gov, agency_forecast, dibbs and sbir_sttr.`}
          action={
            <CapiroButton size="compact" onClick={() => navigate('/intelligence/opportunities')}>
              Back to Funding Opportunities
            </CapiroButton>
          }
        />
      </div>
    );
  }

  return (
    <div className="fov">
      {back}
      <FundingOpportunityDetail
        refValue={{
          source,
          sourceRecordId,
          clientId,
        }}
      />
    </div>
  );
}
