import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  CHANGE_SEVERITY_COLORS,
  CHANGE_SEVERITY_LABELS,
  FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE,
  timelineApiPath,
  type ChangeSeverity,
  type OpportunityTimelineResponse,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

/**
 * The notice history for one solicitation, as a material-change timeline
 * (P28) — vNext port of the canonical OpportunityTimeline.
 *
 * Unchanged rules: never "the notice was updated" (every entry states the
 * DIMENSION, the BEFORE and the AFTER via the API's composed sentence); the
 * four kinds of nothing stay four different sentences; dimensions the provider
 * cannot report are listed at the foot rather than omitted.
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
  // not a gap in Capiro.
  if (source !== 'sam_gov') {
    return (
      <FovCard title="Notice history" testId="fo-timeline">
        <span className="fov-muted">
          Grants.gov publishes no notice history. Amendments to a funding opportunity announcement
          appear as changes to the record itself, not as separate notices.
        </span>
      </FovCard>
    );
  }

  if (!flag.ready) {
    return (
      <FovCard title="Notice history" testId="fo-timeline">
        <FovSkeletonRows rows={3} />
      </FovCard>
    );
  }

  if (!flag.enabled) {
    return (
      <FovCard title="Notice history" testId="fo-timeline">
        <span className="fov-muted" data-testid="fo-timeline-not-enabled">
          Notice history is not enabled for this workspace. This says nothing about whether this
          solicitation has been amended.
        </span>
      </FovCard>
    );
  }

  return (
    <FovCard title="Notice history" testId="fo-timeline">
      {query.isPending ? (
        <FovSkeletonRows rows={4} />
      ) : query.isError ? (
        <FovAlert
          tone="error"
          testId="fo-timeline-error"
          message="The notice history failed to load"
          description="This is a request failure, not an empty history. Nothing can be concluded about whether this solicitation was amended."
        />
      ) : (
        <TimelineBody data={query.data} />
      )}
    </FovCard>
  );
}

/** Dot modifier per severity — maps the shared antd colour words onto the tone table. */
const DOT_CLASS: Record<string, string> = {
  red: 'fov-timeline__dot--red',
  orange: 'fov-timeline__dot--orange',
  gray: 'fov-timeline__dot--gray',
};

function TimelineBody({ data }: { data: OpportunityTimelineResponse }) {
  if (data.entries.length === 0) {
    return (
      <div data-testid={`fo-timeline-${data.coverage}`}>
        <span className="fov-muted">{data.coverageExplanation}</span>
      </div>
    );
  }

  return (
    <>
      <div className="fov-card__facts" style={{ marginTop: 0 }}>
        <span className="fov-fact">
          <span className="fov-fact__label">Notices observed</span>
          <span className="fov-fact__value">{data.entries.length}</span>
        </span>
        <span className="fov-fact">
          <span className="fov-fact__label">Material changes</span>
          <span className="fov-fact__value" data-testid="fo-timeline-change-count">
            {data.changeCount}
          </span>
        </span>
        {(['critical', 'significant', 'informational'] as ChangeSeverity[]).map((severity) =>
          data.bySeverity[severity] > 0 ? (
            <span className="fov-fact" key={severity}>
              <span className="fov-fact__label">{CHANGE_SEVERITY_LABELS[severity]}</span>
              <span className="fov-fact__value">{data.bySeverity[severity]}</span>
            </span>
          ) : null,
        )}
      </div>

      <ol className="fov-timeline">
        {data.entries.map((entry) => {
          const dotColour =
            entry.changes.length === 0
              ? 'gray'
              : (CHANGE_SEVERITY_COLORS[strongest(entry.changes.map((c) => c.severity))] ?? 'blue');
          return (
            <li className="fov-timeline__entry" key={entry.tangoNoticeId}>
              <span className={`fov-timeline__dot ${DOT_CLASS[dotColour] ?? ''}`.trim()} aria-hidden="true" />
              <div data-testid={`fo-timeline-entry-${entry.tangoNoticeId}`}>
                <span className="fov-row">
                  <strong style={{ fontSize: 13 }}>
                    {entry.postedDate
                      ? new Date(entry.postedDate).toLocaleDateString()
                      : 'Date not stated by the source'}
                  </strong>
                  {entry.isFirstObservation ? <FovPill>First observation</FovPill> : null}
                  {entry.sourceUrl ? (
                    <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
                      Source ↗
                    </a>
                  ) : null}
                </span>
                <div>
                  <span className="fov-muted">{entry.title ?? 'Title not stated by the source'}</span>
                </div>
                {entry.changes.length === 0 ? (
                  <span className="fov-muted">
                    {entry.isFirstObservation
                      ? 'The earliest notice Capiro holds. There is nothing before it to compare against.'
                      : 'Nothing Capiro can compare changed in this notice.'}
                  </span>
                ) : (
                  <div className="fov-stack fov-stack--2" style={{ marginTop: 4 }}>
                    {entry.changes.map((change) => (
                      <div key={`${entry.tangoNoticeId}:${change.dimension}`} className="fov-row">
                        <FovPill tone={CHANGE_SEVERITY_COLORS[change.severity]}>
                          {change.dimension.replace(/_/g, ' ')}
                        </FovPill>
                        {/* The composed sentence, not a generic label. It
                            always names at least one of the two values. */}
                        <span style={{ fontSize: 12 }}>{change.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {data.unsupported.length > 0 ? (
        <p className="fov-micro" style={{ margin: '8px 0 0' }} data-testid="fo-timeline-unsupported">
          Not covered by this timeline:{' '}
          {data.unsupported.map((u, i) => (
            <span key={u.dimension}>
              {i > 0 ? ', ' : ''}
              <span title={u.reason} style={{ textDecoration: 'underline dotted' }}>
                {u.dimension.replace(/_/g, ' ')}
              </span>
            </span>
          ))}
          . The provider states none of these on a notice, so a change to one cannot be observed —
          which is not the same as one not having happened.
        </p>
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
