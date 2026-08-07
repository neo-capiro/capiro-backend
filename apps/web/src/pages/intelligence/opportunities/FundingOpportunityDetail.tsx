import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Descriptions, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { FIT_BAND_COLORS, FIT_BAND_LABELS, explainSignals } from './opportunity-explanations.js';
import { AcquisitionPositionPanel } from './AcquisitionPositionPanel.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import { OpportunityTimeline } from './OpportunityTimeline.js';
import { OpportunityRequirementsPanel } from './OpportunityRequirementsPanel.js';
import { GovernmentLandscapePanel } from './GovernmentLandscapePanel.js';
import {
  DetailSectionBoundary,
  OpportunityAssessmentPanel,
} from './OpportunityAssessmentPanel.js';
import {
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
} from './funding-opportunities-api.js';
import './funding-opportunities.css';

const { Text, Title, Paragraph } = Typography;

/**
 * The opportunity detail surface.
 *
 * ── Why a shell, built now, mostly empty ─────────────────────────────────────
 *
 * Eight sections exist from this phase onwards. Acquisition position (P23) is
 * now real — see AcquisitionPositionPanel.tsx — but four still have no data:
 * the government landscape arrives in P33, requirements in P31, the full
 * notice timeline in P28, the full assessment in P32. Building the
 * navigation once and filling it in is deliberate: the alternative is
 * redesigning where things live four more times, and every redesign moves a
 * deep link somebody has already pasted into a ticket.
 *
 * ── The rule every empty section follows ─────────────────────────────────────
 *
 * A section with no data says WHY it has no data, and the two reasons are
 * different facts:
 *
 *   "Not yet available"  — Capiro does not build this yet. A product gap.
 *   "Not provided"       — the source holds no value for it. A source fact.
 *
 * Neither renders as blank, and neither is allowed to read as a negative. A
 * requirements panel that quietly showed nothing would say "this solicitation has
 * no requirements", which is never true and is exactly the sort of claim this
 * program exists to stop making.
 *
 * ── One body, two frames ─────────────────────────────────────────────────────
 *
 * {@link FundingOpportunityDetail} is the whole body. The drawer and the full page
 * both render THIS, unmodified, so the two can never drift into showing different
 * facts about the same record.
 */

/** A section that has no data yet, and says which kind of "no data" it is. */
function PendingSection({
  title,
  arrivesIn,
  what,
  testId,
}: {
  title: string;
  /** The phase that fills this in. Named so the gap is a plan item, not a mystery. */
  arrivesIn: string;
  what: string;
  testId: string;
}) {
  return (
    <Card size="small" title={title} className="fo-detail__section" data-testid={testId}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not yet available. {what} {arrivesIn}
      </Text>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="fo-fact">
      <Text type="secondary" className="fo-fact__label">
        {label}
      </Text>
      <Text className="fo-fact__value">{value}</Text>
    </span>
  );
}

/** Source fields render "Not provided" — a fact about the source, not about us. */
function sourceValue(value: string | null | undefined): React.ReactNode {
  return value && value.trim() ? value : <Text type="secondary">Not provided</Text>;
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
        <Skeleton active paragraph={{ rows: 10 }} />
      </div>
    );
  }

  if (query.isError) {
    /**
     * 404 and "the request failed" are different states and get different copy.
     * "Not found" on a network blip would tell somebody a live solicitation had
     * been withdrawn.
     */
    const status = (query.error as { response?: { status?: number } } | undefined)?.response?.status;
    const notFound = status === 404;
    return (
      <div data-testid={notFound ? 'fo-detail-not-found' : 'fo-detail-error'}>
        <Alert
          type={notFound ? 'warning' : 'error'}
          showIcon
          message={notFound ? 'No such opportunity' : 'The opportunity failed to load'}
          description={
            notFound
              ? `Nothing in the ${SOURCE_LABELS[source] ?? source} catalog matches this record id. The link may be stale, or the record may have been removed from the source.`
              : 'This is a request failure, not an empty record. Nothing can be concluded about the opportunity from it.'
          }
          action={
            notFound ? null : (
              <Button size="small" onClick={() => void query.refetch()}>
                Retry
              </Button>
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
    <div className="fo-detail" data-testid="fo-detail">
      <header className="fo-detail__head">
        <Space size={6} wrap>
          <Tag color={o.source === 'grants_gov' ? 'purple' : 'cyan'}>{SOURCE_LABELS[o.source]}</Tag>
          <Tag>{KIND_LABELS[o.kind]}</Tag>
          {o.baseKind && o.baseKind !== o.kind ? (
            <Tooltip title="This notice was originally posted at an earlier stage. It is not an original solicitation.">
              <Tag color="gold">Was {KIND_LABELS[o.baseKind]}</Tag>
            </Tooltip>
          ) : null}
          {!o.isPursuable ? <Tag>Not a pursuit</Tag> : null}
          {!o.isActive ? <Tag>Closed</Tag> : null}
          {o.workflow ? (
            <Tag color={o.workflow.status === 'pursuing' ? 'geekblue' : 'default'}>
              {WORKFLOW_LABELS[o.workflow.status]}
            </Tag>
          ) : null}
        </Space>
        <Title level={4} style={{ margin: '6px 0 2px' }}>
          {o.title}
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {[o.agency, o.subAgency, o.office].filter(Boolean).join(' · ') || 'Agency not stated'}
          {o.sourceReference ? ` · ${o.sourceReference}` : ''}
        </Text>
      </header>

      {unscored ? (
        <Alert
          type="info"
          showIcon
          className="fo-detail__section"
          data-testid="fo-detail-unscored"
          message="Showing the source record only"
          description="No client is selected, so relevance, eligibility, the recommendation and any decision are not calculated. Open this from a client's inbox row to see them."
        />
      ) : null}

      {/* 1 ─ Executive assessment (P32: its own renderer, shared with the card,
             so the two cannot disagree about the same row). PRIMARY: a reader
             cannot decide without it, so its failure says so loudly. */}
      <DetailSectionBoundary title="Executive assessment" testId="fo-detail-assessment" primary>
        <OpportunityAssessmentPanel opportunity={o} unscored={unscored} />
      </DetailSectionBoundary>

      {/* 2 ─ Fit and eligibility. Two separate concepts, deliberately adjacent so
             the difference is visible rather than merged into one score. */}
      <Card
        size="small"
        title="Fit and eligibility"
        className="fo-detail__section"
        data-testid="fo-detail-fit"
      >
        <div className="fo-card__facts">
          <Fact
            label="Fit"
            value={
              <Tag color={FIT_BAND_COLORS[explained.fitBand]}>
                {FIT_BAND_LABELS[explained.fitBand]}
              </Tag>
            }
          />
          <Fact
            label="Eligibility"
            value={
              <Tooltip title={o.eligibility.reason}>
                <Tag>{ELIGIBILITY_LABELS[o.eligibility.state]}</Tag>
              </Tooltip>
            }
          />
          <Fact label="Relevance score" value={unscored ? 'Not calculated' : o.relevanceScore} />
        </div>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {o.eligibility.reason}
        </Paragraph>
        {explained.signals.length > 0 ? (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {explained.signals.map((s) => (
              <div key={`${s.signal}:${s.matchedOn}`}>
                <Tag color={FIT_BAND_COLORS[s.strength]} style={{ fontSize: 11 }}>
                  {s.label}
                </Tag>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  matched on “{s.matchedOn}”
                </Text>
              </div>
            ))}
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {unscored
              ? 'No client selected, so no signals were evaluated.'
              : 'No matching signals against this client’s recorded profile. That is an absence of evidence, not evidence of a poor fit.'}
          </Text>
        )}
        {o.missingProfileFields.length > 0 ? (
          <div className="fo-card__gaps" style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
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
            </Text>
          </div>
        ) : null}
      </Card>

      {/* 3 ─ Acquisition position (P22/P23) */}
      <DetailSectionBoundary title="Acquisition position" testId="fo-detail-acquisition">
        <AcquisitionPositionPanel opportunity={o} />
      </DetailSectionBoundary>

      {/* 4 ─ Government landscape (P33). Real now: a deterministic evidence
             packet, with verified and inferred kept visibly apart. */}
      <DetailSectionBoundary title="Government landscape" testId="fo-detail-landscape">
        <GovernmentLandscapePanel
          clientId={clientId}
          source={o.source}
          sourceRecordId={o.sourceRecordId}
        />
      </DetailSectionBoundary>

      {/* 5 ─ Pursuit plan. Real data today: P07's decision and P08's owner/next action. */}
      <Card
        size="small"
        title="Pursuit plan"
        className="fo-detail__section"
        data-testid="fo-detail-pursuit"
      >
        <div className="fo-card__facts">
          {/*
            Three separate concepts that can legitimately disagree, shown as three
            separate facts: what the machine suggests, what the team decided, and
            where the work actually is.
          */}
          <Fact
            label="Team decision"
            value={o.decision ? o.decision.decision : 'No decision recorded'}
          />
          <Fact label="Workflow stage" value={o.workflow ? WORKFLOW_LABELS[o.workflow.status] : 'Not started'} />
          <Fact
            label="Owner"
            value={o.workflow?.owner?.name ?? o.workflow?.owner?.email ?? 'Unassigned'}
          />
          <Fact label="Next action" value={o.decision?.nextAction ?? 'None recorded'} />
          <Fact
            label="Next action due"
            value={
              o.decision?.nextActionDueAt
                ? new Date(o.decision.nextActionDueAt).toLocaleDateString()
                : 'No date'
            }
          />
        </div>
        {o.decision?.reason ? (
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            Reason given: {o.decision.reason}
          </Paragraph>
        ) : null}
        {o.workflow?.notes ? (
          <Paragraph style={{ fontSize: 12, marginBottom: 0 }}>{o.workflow.notes}</Paragraph>
        ) : null}
      </Card>

      {/* 6 ─ Timeline. Source dates today; the notice history arrives in P28. */}
      <Card
        size="small"
        title="Timeline"
        className="fo-detail__section"
        data-testid="fo-detail-timeline"
      >
        <div className="fo-card__facts">
          <Fact
            label="Posted"
            value={o.postedDate ? new Date(o.postedDate).toLocaleDateString() : 'Not provided'}
          />
          <Fact
            label="Response deadline"
            value={
              <>
                {deadline.text}
                {deadline.daysRemaining != null && deadline.daysRemaining >= 0 ? (
                  <Text
                    type={deadline.daysRemaining <= 14 ? 'danger' : 'secondary'}
                    style={{ fontSize: 11 }}
                  >
                    {' '}
                    ({deadline.daysRemaining}d)
                  </Text>
                ) : null}
              </>
            }
          />
          <Fact
            label="Closes / archives"
            value={
              o.closeOrArchiveDate
                ? new Date(o.closeOrArchiveDate).toLocaleDateString()
                : 'Not provided'
            }
          />
          <Fact
            label="Source last updated"
            value={
              o.sourceUpdatedAt ? new Date(o.sourceUpdatedAt).toLocaleString() : 'Not provided'
            }
          />
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          These are the dates the current source record states. How they CHANGED is the notice
          history below.
        </Text>
      </Card>

      {/* 6b ─ Notice history (P28). Its own card, and its own flag: the dates
             above are the record's current state, and the timeline is the
             record of how it got there. Two different questions. */}
      <DetailSectionBoundary title="Notice history" testId="fo-timeline">
        <OpportunityTimeline source={o.source} sourceRecordId={o.sourceRecordId} />
      </DetailSectionBoundary>

      {/* 7 ─ Requirements (P31). Real now: every row quotes the document it
             came from, and an empty panel says WHICH kind of empty. */}
      <DetailSectionBoundary title="Requirements" testId="fo-detail-requirements">
        <OpportunityRequirementsPanel source={o.source} sourceRecordId={o.sourceRecordId} />
      </DetailSectionBoundary>

      {/* 8 ─ Source record. Provenance, always, and the link out. */}
      <Card
        size="small"
        title="Source record"
        className="fo-detail__section"
        data-testid="fo-detail-source"
      >
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Source">{SOURCE_LABELS[o.source]}</Descriptions.Item>
          <Descriptions.Item label="Source record id">{o.sourceRecordId}</Descriptions.Item>
          <Descriptions.Item label="Source reference">
            {sourceValue(o.sourceReference)}
          </Descriptions.Item>
          <Descriptions.Item label="Notice type">
            {KIND_LABELS[o.kind]}
            {o.kindRaw ? ` (source says: ${o.kindRaw})` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="Status">{sourceValue(o.status)}</Descriptions.Item>
          <Descriptions.Item label={money.label}>{money.value}</Descriptions.Item>
          <Descriptions.Item label="Set-aside">{sourceValue(o.setAside)}</Descriptions.Item>
          <Descriptions.Item label="NAICS">
            {o.naicsCodes.length ? o.naicsCodes.join(', ') : sourceValue(null)}
          </Descriptions.Item>
          <Descriptions.Item label="PSC">
            {o.pscCodes.length ? o.pscCodes.join(', ') : sourceValue(null)}
          </Descriptions.Item>
          <Descriptions.Item label="Assistance Listings">
            {o.assistanceListings.length ? o.assistanceListings.join(', ') : sourceValue(null)}
          </Descriptions.Item>
          <Descriptions.Item label="Place of performance">
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
          </Descriptions.Item>
          <Descriptions.Item label="Source URL">
            {o.sourceUrl ? (
              <a href={o.sourceUrl} target="_blank" rel="noreferrer">
                {o.sourceUrl} <ExportOutlined aria-hidden />
              </a>
            ) : (
              sourceValue(null)
            )}
          </Descriptions.Item>
        </Descriptions>
        {o.summary ? (
          o.summaryIsLink ? (
            <Paragraph style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
              <a href={o.summary} target="_blank" rel="noreferrer">
                Read the full description on SAM.gov <ExportOutlined aria-hidden />
              </a>
            </Paragraph>
          ) : (
            <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
              {o.summary}
            </Paragraph>
          )
        ) : (
          <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
            The source provides no description for this record.
          </Paragraph>
        )}
      </Card>
    </div>
  );
}

/**
 * The full-page frame: the same body, reached by a deep link.
 *
 * Route params rather than props, so this is what App.tsx mounts. It renders the
 * identical {@link FundingOpportunityDetail} the drawer renders — the two frames
 * cannot show different facts about the same record because there is only one body.
 */
export function FundingOpportunityDetailPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  /**
   * The forecast flag, read here rather than inferred from the URL.
   *
   * A deep link to `agency_forecast/...` in a workspace without the flag must
   * render a NAMED not-enabled state, not the forecast body waiting on a route
   * that will 404 anyway (the API's own forecast guard 404s with the flag off).
   * Saying so up front is the difference between "this workspace does not have
   * agency forecasts" and "that forecast does not exist".
   */
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const params = useParams<{ source?: string; sourceRecordId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  if (!ready || !forecasts.ready) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!enabled) {
    return (
      <Alert
        type="info"
        showIcon
        message="Funding Opportunities is not enabled for this workspace"
        description="Grants.gov and SAM.gov opportunity matching is available on request."
      />
    );
  }

  const source = params.source ?? '';
  const sourceRecordId = params.sourceRecordId ?? '';
  const clientId = searchParams.get('clientId');

  const back = (
    <Button
      size="small"
      className="fo-detail__back"
      onClick={() => navigate('/intelligence/opportunities')}
    >
      ← Funding Opportunities
    </Button>
  );

  // ── Agency forecasts: a different record type, at the same route shape ──────
  if (source === FORECAST_SOURCE && sourceRecordId) {
    if (!forecasts.enabled) {
      return (
        <div className="fo-page" data-testid="fo-forecast-not-enabled">
          <Alert
            type="info"
            showIcon
            message="Agency forecasts are not enabled for this workspace"
            description="Pre-solicitation agency forecasts are a separate capability from Grants.gov and SAM.gov opportunity matching. This link will work once they are turned on; it says nothing about whether the forecast exists."
            action={back}
          />
        </div>
      );
    }
    return (
      <div className="fo-page">
        {back}
        <ForecastOpportunityDetail forecastId={sourceRecordId} clientId={clientId} />
      </div>
    );
  }

  // A malformed URL is a NAMED state, not a blank page and not a request. There is
  // no point asking the API about a source rail that does not exist.
  if (!isOpportunitySource(source) || !sourceRecordId) {
    return (
      <div className="fo-page" data-testid="fo-detail-bad-ref">
        <Alert
          type="warning"
          showIcon
          message="That is not a valid opportunity link"
          description={`“${source || 'nothing'}” is not a source Capiro holds. Valid sources are grants_gov, sam_gov and agency_forecast.`}
          action={
            <Button size="small" onClick={() => navigate('/intelligence/opportunities')}>
              Back to Funding Opportunities
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="fo-page">
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
