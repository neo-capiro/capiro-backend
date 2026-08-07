import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
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
} from './funding-opportunities-api.js';
import './funding-opportunities.css';

const { Paragraph, Text, Title } = Typography;

/**
 * The agency-forecast detail body.
 *
 * ── Why this is a separate component from FundingOpportunityDetail ────────────
 *
 * Not styling, and not convenience: the two records are different shapes. A
 * `FundingOpportunity` carries a response deadline, an eligibility determination
 * and a money figure; a forecast carries none of the three, and the API
 * deliberately serves it from its own route with its own type rather than as a
 * `FundingOpportunity` with three holes in it (a hole in an eligibility field
 * reads as "not eligible"). Reusing the other body would have meant either
 * inventing those fields or rendering "Unknown" against questions that do not
 * apply.
 *
 * What IS shared: the frame. The drawer and the full page both render this
 * unmodified, exactly as they both render the other body unmodified, so there is
 * still one rendering per record type and no compact variant to drift.
 *
 * ── The section order, and the two honest-absence rules ──────────────────────
 *
 *   1. Early-signal assessment — the recommendation, or why there is not one.
 *   2. Evidence — every signal, including the ones that could not be evaluated.
 *   3. What happens next — the linkage gap, stated as a gap.
 *   4. Team plan — decision, owner, next action.
 *   5. Source record — provenance and freshness.
 *
 * "Not provided by the source" and "not yet available in Capiro" are different
 * sentences and are never interchanged. Neither is ever rendered as blank, as
 * zero, or as a negative.
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
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (query.isError) {
    // 404 and "the request failed" get different copy, for the same reason the
    // opportunity detail separates them: "no such forecast" on a network blip
    // would tell somebody an agency had dropped a plan it still holds.
    const status = (query.error as { response?: { status?: number } } | undefined)?.response?.status;
    const notFound = status === 404;
    return (
      <div data-testid={notFound ? 'fo-forecast-not-found' : 'fo-forecast-error'}>
        <Alert
          type={notFound ? 'warning' : 'error'}
          showIcon
          message={notFound ? 'No such agency forecast' : 'The agency forecast failed to load'}
          description={
            notFound
              ? 'Capiro holds no forecast with this id. The link may be stale, the agency may have removed the record, or agency forecasts may not be enabled for this workspace.'
              : 'This is a request failure, not an empty record. Nothing can be concluded about the forecast from it.'
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

  const f = query.data;
  const unscored = f.clientId == null;

  return (
    <div className="fo-detail fo-detail--forecast" data-testid="fo-forecast-detail">
      <header className="fo-detail__head">
        <Space size={6} wrap>
          <Tooltip title="An agency's own statement of what it expects to buy. Not a solicitation, and not a competition anybody can respond to yet.">
            <Tag color="gold">{INBOX_SOURCE_LABELS.agency_forecast}</Tag>
          </Tooltip>
          {f.facts.isActive === false ? (
            <Tag color="red">Withdrawn by the agency</Tag>
          ) : null}
          {f.facts.status ? <Tag>{f.facts.status}</Tag> : null}
        </Space>
        <Title level={4} style={{ margin: '6px 0 2px' }}>
          {f.title}
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {[f.agency, f.departmentName, f.organizationAgencyName, f.officeName]
            .filter(Boolean)
            .join(' · ') || 'Agency not stated'}
          {f.externalId ? ` · ${f.externalId}` : ''}
        </Text>
      </header>

      {unscored ? (
        <Alert
          type="info"
          showIcon
          className="fo-detail__section"
          data-testid="fo-forecast-unscored"
          message="Showing the agency's record only"
          description="No client is selected, so fit and the early-signal recommendation are not calculated. Open this from a client's inbox row to see them."
        />
      ) : null}

      {/* 1 ─ Early-signal assessment */}
      <Card
        size="small"
        title="Early-signal assessment"
        className="fo-detail__section"
        data-testid="fo-forecast-assessment"
      >
        {f.recommendation ? (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space size={6} wrap>
              <Tag
                color={
                  FORECAST_RECOMMENDATION_COLORS[
                    f.recommendation.forecastRecommendation as ForecastRecommendation
                  ]
                }
                data-testid="fo-forecast-recommendation"
              >
                {FORECAST_RECOMMENDATION_LABELS[
                  f.recommendation.forecastRecommendation as ForecastRecommendation
                ] ?? f.recommendation.forecastRecommendation}
              </Tag>
              {/*
                Evidence quality — and for a forecast it is emphatically NOT a
                probability that the forecast becomes a real solicitation, which
                is the specific misreading available here and nowhere else.
              */}
              <Tooltip title="How good the evidence is. NOT a probability of winning, and NOT a probability that this forecast becomes a real solicitation.">
                <Tag data-testid="fo-forecast-confidence">
                  Confidence: {f.recommendation.recommendationConfidence}
                </Tag>
              </Tooltip>
            </Space>
            <div>
              <Text type="secondary" className="fo-fact__label">
                Why
              </Text>
              <div>
                <Text>{f.recommendation.primaryReason}</Text>
              </div>
            </div>
            <div>
              <Text type="secondary" className="fo-fact__label">
                Main risk
              </Text>
              <div>
                <Text>{f.recommendation.primaryRisk ?? 'No specific risk identified.'}</Text>
              </div>
            </div>
            <div>
              <Text type="secondary" className="fo-fact__label">
                Recommended next step
              </Text>
              <div>
                <Text data-testid="fo-forecast-next-action">
                  {f.recommendation.recommendedNextAction}
                </Text>
              </div>
            </div>
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {unscored
              ? 'Not calculated without a client. Fit is a fact about a client-forecast pair, not about the agency’s plan.'
              : 'Not calculated: this client has no profile record to judge fit against.'}
          </Text>
        )}
      </Card>

      {/* 2 ─ Evidence, including what could not be evaluated */}
      <Card
        size="small"
        title="Evidence"
        className="fo-detail__section"
        data-testid="fo-forecast-evidence"
      >
        {f.recommendation ? (
          <>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
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
                      <Tooltip title={unavailable.reason}>
                        <Tag>{label}: not evaluated</Tag>
                      </Tooltip>
                    ) : (
                      <Tag color={established ? 'green' : 'default'}>
                        {label}: {established ? 'yes' : 'no match'}
                      </Tag>
                    )}
                  </div>
                );
              })}
            </Space>
            {f.missingProfileFields.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>
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
                </Text>
              </div>
            ) : null}
          </>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            No signals were evaluated, so nothing here says anything about this client’s fit.
          </Text>
        )}
      </Card>

      {/* 3 ─ What happens next: the linkage gap, stated as a gap */}
      <Card
        size="small"
        title="What happens next"
        className="fo-detail__section"
        data-testid="fo-forecast-linkage"
      >
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
          {/*
            The plan's "eventual opportunity linkage" line. Stated as a gap in
            Capiro, not as a fact about the agency: "no solicitation followed" is
            a claim, and it is not one anybody can make from this record.
          */}
          Capiro does not yet link a forecast to the solicitation it becomes.{' '}
          {f.linkedOpportunity == null ? 'Nothing is linked to this record.' : null} That is an
          absence of a link, not evidence that no solicitation followed — the only honest way to
          make the link is an exact identifier the agency does not publish on this record, and
          inferring one from the title text is the kind of guess this system does not make.
        </Paragraph>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Until then: watch for a matching notice on the SAM.gov rail, and keep any decision you
          record here — it stays attached to the forecast even after a real notice appears.
        </Text>
      </Card>

      {/* 4 ─ Team plan */}
      <Card
        size="small"
        title="Team plan"
        className="fo-detail__section"
        data-testid="fo-forecast-plan"
      >
        <div className="fo-card__facts">
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Team decision
            </Text>
            <Text className="fo-fact__value">
              {f.decision ? f.decision.decision : 'No decision recorded'}
            </Text>
          </span>
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Workflow stage
            </Text>
            <Text className="fo-fact__value">{f.workflow?.status ?? 'Not started'}</Text>
          </span>
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Next action
            </Text>
            <Text className="fo-fact__value">{f.decision?.nextAction ?? 'None recorded'}</Text>
          </span>
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Next action due
            </Text>
            <Text className="fo-fact__value">
              {f.decision?.nextActionDueAt
                ? new Date(f.decision.nextActionDueAt).toLocaleDateString()
                : 'No date'}
            </Text>
          </span>
        </div>
        {f.decision?.reason ? (
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            Reason given: {f.decision.reason}
          </Paragraph>
        ) : null}
        {onAction ? (
          <div className="fo-card__actions" data-testid="fo-forecast-detail-actions">
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

      {/* 5 ─ Source record */}
      <Card
        size="small"
        title="Source record"
        className="fo-detail__section"
        data-testid="fo-forecast-source"
      >
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Source">
            {INBOX_SOURCE_LABELS.agency_forecast}
          </Descriptions.Item>
          <Descriptions.Item label="Agency system">
            {f.facts.sourceSystem ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Provider record id">{f.sourceRecordId}</Descriptions.Item>
          <Descriptions.Item label="Agency’s own id">
            {f.externalId ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Anticipated award">
            {formatSourceDate(f.facts.anticipatedAwardDate, 'Not stated by the agency')}
          </Descriptions.Item>
          <Descriptions.Item label="Anticipated solicitation">
            {/* Always this sentence: the resource carries no such field at all. */}
            {notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Estimated period">
            {f.facts.estimatedPeriod ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Fiscal year">
            {f.facts.fiscalYear ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="NAICS">{f.naicsCode ?? notProvided()}</Descriptions.Item>
          <Descriptions.Item label="PSC">{f.pscCode ?? notProvided()}</Descriptions.Item>
          <Descriptions.Item label="Set-aside">{f.setAside ?? notProvided()}</Descriptions.Item>
          <Descriptions.Item label="Contract vehicle">
            {f.contractVehicle ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Place of performance">
            {f.placeOfPerformance ?? notProvided()}
          </Descriptions.Item>
          <Descriptions.Item label="Agency contact">
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
          </Descriptions.Item>
          <Descriptions.Item label="Freshness">
            <span data-testid="fo-forecast-detail-freshness">
              {formatForecastFreshness(f.facts)}
            </span>
          </Descriptions.Item>
        </Descriptions>
        {f.description ? (
          <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
            {/*
              Untrusted source text. Rendered as prose, never interpreted — an
              instruction inside an agency description is data, not a command.
            */}
            {f.description}
          </Paragraph>
        ) : (
          <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
            The agency provides no description for this record.
          </Paragraph>
        )}
      </Card>
    </div>
  );
}

/** A SOURCE absence — a fact about the agency's record, not about Capiro. */
function notProvided() {
  return <Text type="secondary">Not provided by the source</Text>;
}

/**
 * The signal rows, in the order the evidence panel lists them.
 *
 * Strongest-first, matching `forecast-relevance.ts`'s own rule order: the four
 * that can produce `shape_now` on their own come before the three that can only
 * ever support a `monitor`.
 */
const SIGNAL_LABELS: Array<
  [keyof Omit<import('./funding-opportunities-api.js').ForecastSignalEvidence, 'unavailable'>, string]
> = [
  ['exactNaicsMatch', 'Exact NAICS match'],
  ['exactPscMatch', 'Exact PSC match'],
  ['capabilityMatch', 'Recorded capability match'],
  ['programElementLinkedSourceBacked', 'Program Element named in the record'],
  ['priorAgencyHistory', 'Prior award history with this agency'],
  ['knownVehicleAccess', 'Known contract-vehicle access'],
  ['locationMatch', 'Client facility in a named state'],
  ['reviewedStrategicPriority', 'Reviewed strategic priority'],
];
