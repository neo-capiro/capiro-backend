import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { opportunityDescriptionText } from '../../../pages/intelligence/opportunities/opportunity-description.js';
import {
  FIT_BAND_COLORS,
  FIT_BAND_LABELS,
  explainSignals,
} from '../../../pages/intelligence/opportunities/opportunity-explanations.js';
import {
  DIBBS_SOURCE,
  SBIR_SOURCE,
  ELIGIBILITY_LABELS,
  FORECAST_SOURCE,
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  KIND_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  formatSourceDate,
  isOpportunitySource,
  moneyLine,
  type CatalogOpportunityRef,
  type FundingOpportunity,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { AcquisitionPositionPanel } from './AcquisitionPositionPanel.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import { TangoOpportunityDetail } from './TangoOpportunityDetail.js';
import { OpportunityClientActions } from './OpportunityClientActions.js';
import { sourceWebUrl } from './opportunity-query-cache.js';
import { GovernmentLandscapePanel } from './GovernmentLandscapePanel.js';
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
  const [contextOpen, setContextOpen] = useState(false);
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
    const status = (query.error as { response?: { status?: number } } | undefined)?.response
      ?.status;
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
  const description = opportunityDescriptionText(o.summary ?? '');
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
          description="No client is selected, so relevance, eligibility, the recommendation and any decision are not calculated. Choose a client below to assess the fit and save this opportunity."
        />
      ) : null}

      <FovCard title="Opportunity at a glance" testId="fo-detail-glance">
        <div className="fov-card__facts">
          <FovFact label="Response deadline" value={deadline.text} />
          <FovFact label={money.label} value={money.value} />
          <FovFact
            label="Source updated"
            value={
              o.sourceUpdatedAt ? new Date(o.sourceUpdatedAt).toLocaleString() : 'Not provided'
            }
          />
        </div>
        {o.summary && !o.summaryIsLink ? (
          <p style={{ whiteSpace: 'pre-wrap' }}>{description}</p>
        ) : (
          <p className="fov-muted">Read the source record for the full description.</p>
        )}
        {sourceWebUrl(o.sourceUrl) ? (
          <a href={sourceWebUrl(o.sourceUrl)!} target="_blank" rel="noreferrer">
            Open source record ↗
          </a>
        ) : (
          <span className="fov-muted">The source did not provide a link.</span>
        )}
      </FovCard>
      {/* 2 ─ Fit and eligibility. Two separate concepts, deliberately adjacent
             so the difference is visible rather than merged into one score. */}
      <FovCard title="Client fit and eligibility" testId="fo-detail-fit">
        <div className="fov-card__facts">
          <FovFact
            label="Fit"
            value={
              <FovPill tone={FIT_BAND_COLORS[explained.fitBand]}>
                {unscored
                  ? 'Not evaluated'
                  : explained.strongest
                    ? FIT_BAND_LABELS[explained.fitBand]
                    : 'No fit evidence'}
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
          Eligibility: {o.eligibility.reason}
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
              : 'No fit evidence in this client’s recorded profile. Add specific capabilities or funding priorities to improve matching; organization types are used separately to check grant eligibility.'}
          </span>
        )}
        {o.missingProfileFields.length > 0 ? (
          <div className="fov-card__gaps" style={{ marginTop: 8 }}>
            <span className="fov-micro">
              Complete this client’s matching profile:{' '}
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

      <OpportunityClientActions
        source={o.source}
        sourceRecordId={o.sourceRecordId}
        clientId={clientId}
        title={o.title}
        isActive={o.isActive}
        canPursue={o.isPursuable}
        workflowStatus={o.workflow?.status}
        notes={o.workflow?.notes}
        ownerUserId={o.workflow?.owner?.userId ?? null}
        nextAction={
          o.workflow?.nextAction !== undefined ? o.workflow.nextAction : o.decision?.nextAction
        }
        nextActionDueAt={
          o.workflow?.nextActionDueAt !== undefined
            ? o.workflow.nextActionDueAt
            : o.decision?.nextActionDueAt
        }
        pursuitLabel={
          o.kind === 'sources_sought' ||
          o.baseKind === 'sources_sought' ||
          /\brfi\b|request for information|sources[ _-]+sought/i.test(o.kindRaw ?? '')
            ? 'Plan response'
            : 'Pursue'
        }
      />
      {/* 6 ─ Pursuit plan. Three separate concepts that can legitimately
             disagree, shown as three separate facts. */}
      <FovCard title="Team plan" testId="fo-detail-pursuit">
        <div className="fov-card__facts">
          <FovFact
            label="Team decision"
            value={o.decision ? o.decision.decision : 'No decision recorded'}
          />
          <FovFact
            label="Tracking status"
            value={o.workflow ? WORKFLOW_LABELS[o.workflow.status] : 'Not started'}
          />
          <FovFact
            label="Owner"
            value={o.workflow?.owner?.name ?? o.workflow?.owner?.email ?? 'Unassigned'}
          />
          <FovFact
            label="Next action"
            value={o.workflow?.nextAction ?? o.decision?.nextAction ?? 'None recorded'}
          />
          <FovFact
            label="Next action due"
            value={
              (o.workflow?.nextActionDueAt ?? o.decision?.nextActionDueAt)
                ? formatSourceDate(
                    (o.workflow?.nextActionDueAt ?? o.decision?.nextActionDueAt)!,
                    'No date',
                  )
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

      <details>
        <summary>Source details and history</summary>
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
                  {o.assistanceListings.length
                    ? o.assistanceListings.join(', ')
                    : sourceValue(null)}
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
                  {sourceWebUrl(o.sourceUrl) ? (
                    <a href={sourceWebUrl(o.sourceUrl)!} target="_blank" rel="noreferrer">
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
                <a href={sourceWebUrl(o.summary) ?? undefined} target="_blank" rel="noreferrer">
                  Read the full description on SAM.gov ↗
                </a>
              </p>
            ) : (
              <p className="fov-muted" style={{ margin: '10px 0 0' }}>
                {description}
              </p>
            )
          ) : (
            <p className="fov-muted" style={{ margin: '10px 0 0' }}>
              The source provides no description for this record.
            </p>
          )}
        </FovCard>{' '}
        {/* 7 ─ Timeline. Source dates today; how they CHANGED is the notice
             history below. */}
        <FovCard title="Timeline" testId="fo-detail-timeline">
          <div className="fov-card__facts">
            <FovFact
              label="Posted"
              value={
                o.postedDate
                  ? formatSourceDate(o.postedDate, 'Not provided')
                  : 'Not provided'
              }
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
                  ? formatSourceDate(o.closeOrArchiveDate, 'Not provided')
                  : 'Not provided'
              }
            />
            <FovFact
              label="Source last updated"
              value={
                o.sourceUpdatedAt ? new Date(o.sourceUpdatedAt).toLocaleString() : 'Not provided'
              }
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
      </details>
      <details onToggle={(event) => setContextOpen(event.currentTarget.open)}>
        <summary>More context</summary>
        {contextOpen ? (
          <>
            {/* 1 ─ Executive assessment (P32). PRIMARY: a reader cannot decide
             without it, so its failure says so loudly. */}
            <DetailSectionBoundary
              title="Executive assessment"
              testId="fo-detail-assessment"
              primary
            >
              <OpportunityAssessmentPanel opportunity={o} unscored={unscored} />
            </DetailSectionBoundary>

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

            {/* 5c ─ Budget beta context (P44). Keyed on the CLIENT, not this notice. */}
            <DetailSectionBoundary
              title="Federal account execution"
              testId="fo-detail-budget-section"
            >
              <OpportunityBudgetContext clientId={clientId} />
            </DetailSectionBoundary>

            {/* 5d ─ Procurement risk (P45). Client-keyed, like the budget panel. */}
            <DetailSectionBoundary title="Procurement risk" testId="fo-detail-risk-section">
              <OpportunityRiskPanel clientId={clientId} />
            </DetailSectionBoundary>
          </>
        ) : null}
      </details>
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

  if ((source === DIBBS_SOURCE || source === SBIR_SOURCE) && sourceRecordId) {
    return (
      <div className="fov">
        {back}
        <TangoOpportunityDetail
          source={source}
          sourceRecordId={sourceRecordId}
          clientId={clientId}
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
