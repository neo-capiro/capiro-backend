import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Space, Tag, Timeline, Tooltip, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  CHANGE_SEVERITY_COLORS,
  CHANGE_SEVERITY_LABELS,
  FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE,
  timelineApiPath,
  type ChangeSeverity,
  type OpportunityTimelineResponse,
} from './funding-opportunities-api.js';

const { Text, Paragraph } = Typography;

/**
 * The notice history for one solicitation, as a material-change timeline (P28).
 *
 * ── The one thing this panel must never do ───────────────────────────────────
 *
 * Say "the notice was updated". That label is the reason this phase exists: an
 * amendment that moved the response deadline two weeks earlier and one that
 * added a Q&A attachment are not the same event, and a reader who has to open
 * the source to find out which is a reader the timeline did not help. Every
 * entry below states the DIMENSION, the BEFORE and the AFTER.
 *
 * ── Four different kinds of nothing ──────────────────────────────────────────
 *
 * An empty timeline has four causes and they are not interchangeable:
 *
 *   the flag is off             — Capiro has the capability, this workspace has
 *                                 not enabled it. Says nothing about the notice.
 *   `no_notices_synced`         — the sync has never run. Also says nothing
 *                                 about the notice.
 *   `not_crosswalked`           — notices exist but none is provably THIS
 *                                 solicitation. Says nothing about the notice.
 *   one entry, no changes       — the solicitation has been observed once and
 *                                 never amended. This is the ONLY one of the
 *                                 four that is a fact about the notice.
 *
 * Collapsing any of the first three into "no amendments" would be the false
 * claim the whole program is built to avoid.
 *
 * ── Dimensions the provider cannot report ────────────────────────────────────
 *
 * Four of the plan's change dimensions have no counterpart in the provider's
 * notice resource. They are listed explicitly at the foot of the panel rather
 * than omitted, because a reader who knows the timeline covers deadlines and
 * set-asides but NOT stage transitions can go check the source for the one it
 * misses; a reader who was never told assumes it covers everything.
 */
export function OpportunityTimeline({
  source,
  sourceRecordId,
}: {
  source: string;
  sourceRecordId: string;
}) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE);
  const enabled = flag.ready && flag.enabled && source === 'sam_gov';

  const query = useQuery<OpportunityTimelineResponse>({
    queryKey: ['funding-opportunity-timeline', source, sourceRecordId],
    queryFn: async () =>
      (await api.get<OpportunityTimelineResponse>(timelineApiPath(source, sourceRecordId))).data,
    retry: false,
    enabled,
  });

  // Grants.gov publishes no notice history at all — a fact about the source,
  // not a gap in Capiro, and the API refuses the request rather than answering
  // it emptily.
  if (source !== 'sam_gov') {
    return (
      <Card size="small" title="Notice history" className="fo-detail__section" data-testid="fo-timeline">
        <Text type="secondary" style={{ fontSize: 12 }}>
          Grants.gov publishes no notice history. Amendments to a funding opportunity announcement
          appear as changes to the record itself, not as separate notices.
        </Text>
      </Card>
    );
  }

  if (!flag.ready) {
    return (
      <Card size="small" title="Notice history" className="fo-detail__section" data-testid="fo-timeline">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (!flag.enabled) {
    return (
      <Card size="small" title="Notice history" className="fo-detail__section" data-testid="fo-timeline">
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-timeline-not-enabled">
          Notice history is not enabled for this workspace. This says nothing about whether this
          solicitation has been amended.
        </Text>
      </Card>
    );
  }

  return (
    <Card size="small" title="Notice history" className="fo-detail__section" data-testid="fo-timeline">
      {query.isPending ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : query.isError ? (
        <Alert
          type="error"
          showIcon
          data-testid="fo-timeline-error"
          message="The notice history failed to load"
          description="This is a request failure, not an empty history. Nothing can be concluded about whether this solicitation was amended."
        />
      ) : (
        <TimelineBody data={query.data} />
      )}
    </Card>
  );
}

function TimelineBody({ data }: { data: OpportunityTimelineResponse }) {
  if (data.entries.length === 0) {
    return (
      <div data-testid={`fo-timeline-${data.coverage}`}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {data.coverageExplanation}
        </Text>
      </div>
    );
  }

  return (
    <>
      <div className="fo-card__facts" style={{ marginTop: 0 }}>
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Notices observed
          </Text>
          <Text className="fo-fact__value">{data.entries.length}</Text>
        </span>
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Material changes
          </Text>
          <Text className="fo-fact__value" data-testid="fo-timeline-change-count">
            {data.changeCount}
          </Text>
        </span>
        {(['critical', 'significant', 'informational'] as ChangeSeverity[]).map((severity) =>
          data.bySeverity[severity] > 0 ? (
            <span className="fo-fact" key={severity}>
              <Text type="secondary" className="fo-fact__label">
                {CHANGE_SEVERITY_LABELS[severity]}
              </Text>
              <Text className="fo-fact__value">{data.bySeverity[severity]}</Text>
            </span>
          ) : null,
        )}
      </div>

      <Timeline
        mode="left"
        items={data.entries.map((entry) => ({
          color:
            entry.changes.length === 0
              ? 'gray'
              : (CHANGE_SEVERITY_COLORS[strongest(entry.changes.map((c) => c.severity))] ?? 'blue'),
          children: (
            <div data-testid={`fo-timeline-entry-${entry.tangoNoticeId}`}>
              <Space size={6} wrap>
                <Text strong style={{ fontSize: 13 }}>
                  {entry.postedDate
                    ? new Date(entry.postedDate).toLocaleDateString()
                    : 'Date not stated by the source'}
                </Text>
                {entry.isFirstObservation ? <Tag>First observation</Tag> : null}
                {entry.sourceUrl ? (
                  <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
                    Source <ExportOutlined aria-hidden />
                  </a>
                ) : null}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {entry.title ?? 'Title not stated by the source'}
                </Text>
              </div>
              {entry.changes.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {entry.isFirstObservation
                    ? 'The earliest notice Capiro holds. There is nothing before it to compare against.'
                    : 'Nothing Capiro can compare changed in this notice.'}
                </Text>
              ) : (
                <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 4 }}>
                  {entry.changes.map((change) => (
                    <div key={`${entry.tangoNoticeId}:${change.dimension}`}>
                      <Tag color={CHANGE_SEVERITY_COLORS[change.severity]} style={{ fontSize: 11 }}>
                        {change.dimension.replace(/_/g, ' ')}
                      </Tag>
                      {/*
                        The composed sentence, not a generic label. It always
                        names at least one of the two values.
                      */}
                      <Text style={{ fontSize: 12 }}>{change.summary}</Text>
                    </div>
                  ))}
                </Space>
              )}
            </div>
          ),
        }))}
      />

      {data.unsupported.length > 0 ? (
        <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 0 }} data-testid="fo-timeline-unsupported">
          Not covered by this timeline:{' '}
          {data.unsupported.map((u, i) => (
            <span key={u.dimension}>
              {i > 0 ? ', ' : ''}
              <Tooltip title={u.reason}>
                <span style={{ textDecoration: 'underline dotted' }}>
                  {u.dimension.replace(/_/g, ' ')}
                </span>
              </Tooltip>
            </span>
          ))}
          . The provider states none of these on a notice, so a change to one cannot be observed —
          which is not the same as one not having happened.
        </Paragraph>
      ) : null}
    </>
  );
}

/** The most severe band present. Drives the dot colour for an entry. */
function strongest(severities: ChangeSeverity[]): ChangeSeverity {
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('significant')) return 'significant';
  return 'informational';
}
