import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE,
  LANDSCAPE_SOURCE_LABELS,
  landscapeApiPath,
  type LandscapePacketView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

/**
 * Capiro's own government-affairs context for one client-opportunity pair
 * (P33) — vNext port of the canonical GovernmentLandscapePanel.
 *
 * Same rules: verified and inferred look different AND read different; a
 * source Capiro cannot read yet makes no claim (`not_wired` is worded so it
 * cannot be read as a finding, `empty` IS a finding); coverage is not
 * confidence.
 */
export function GovernmentLandscapePanel({
  clientId,
  source,
  sourceRecordId,
}: {
  clientId: string | null;
  source: string;
  sourceRecordId: string;
}) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE);
  const enabled = flag.ready && flag.enabled && clientId != null && source === 'sam_gov';

  const query = useQuery<LandscapePacketView>({
    queryKey: ['funding-opportunity-landscape', source, sourceRecordId, clientId],
    queryFn: async () =>
      (await api.get<LandscapePacketView>(landscapeApiPath(source, sourceRecordId, clientId!))).data,
    retry: false,
    enabled,
  });

  const body = () => {
    if (source !== 'sam_gov') {
      return (
        <span className="fov-muted">
          Government landscape context is composed for SAM.gov contract opportunities. A grant’s
          programme context lives on the client’s own intelligence surface.
        </span>
      );
    }
    if (clientId == null) {
      return (
        <span className="fov-muted" data-testid="fo-landscape-unscored">
          Not composed without a client. The landscape is a fact about a client-opportunity pair,
          not about the notice.
        </span>
      );
    }
    if (!flag.ready) return <FovSkeletonRows rows={3} />;
    if (!flag.enabled) {
      return (
        <span className="fov-muted" data-testid="fo-landscape-not-enabled">
          Government landscape context is not enabled for this workspace. This says nothing about
          what context exists for this opportunity.
        </span>
      );
    }
    if (query.isPending) return <FovSkeletonRows rows={4} />;
    if (query.isError) {
      return (
        <FovAlert
          tone="error"
          testId="fo-landscape-error"
          message="Government landscape failed to load"
          description="This is a request failure, not an absence of context. Nothing follows from it about this opportunity."
        />
      );
    }

    const packet = query.data;
    const notWired = packet.sources.filter((s) => s.state === 'not_wired');
    const emptied = packet.sources.filter((s) => s.state === 'empty');

    return (
      <div className="fov-stack fov-stack--8">
        {packet.items.length === 0 ? (
          <span className="fov-muted" data-testid="fo-landscape-empty">
            No government-affairs context connects this client to this opportunity in the sources
            Capiro reads today. That is an absence of a connection, not evidence against pursuing.
          </span>
        ) : (
          packet.items.map((item) => (
            <div key={`${item.source}:${item.sourceId}`} data-testid={`fo-landscape-item-${item.sourceId}`}>
              <span className="fov-row">
                <FovPill>{LANDSCAPE_SOURCE_LABELS[item.source] ?? item.source}</FovPill>
                {item.basis === 'source_backed' ? (
                  <FovPill tone="green">Verified</FovPill>
                ) : (
                  <FovPill
                    tone="orange"
                    title="Two things resemble each other. Nobody has reviewed the link, and it is excluded from every high-confidence action."
                  >
                    Inferred — not reviewed
                  </FovPill>
                )}
                <span className="fov-micro">matched on “{item.matchedOn}”</span>
              </span>
              <div>
                <span style={{ fontSize: 12 }}>{item.label}</span>
              </div>
            </div>
          ))
        )}

        <div data-testid="fo-landscape-coverage">
          <span className="fov-micro">
            {/* Coverage, never confidence. A fully-covered packet can be empty. */}
            {packet.coverage.available} of {packet.coverage.wired} readable sources contributed;{' '}
            {packet.coverage.declared} are planned in total.
          </span>
        </div>

        {emptied.length > 0 ? (
          <span className="fov-micro" data-testid="fo-landscape-empty-sources">
            Read and holding nothing for this pair:{' '}
            {emptied.map((s) => LANDSCAPE_SOURCE_LABELS[s.source] ?? s.source).join(', ')}.
          </span>
        ) : null}

        {notWired.length > 0 ? (
          <p className="fov-micro" style={{ margin: 0 }} data-testid="fo-landscape-not-wired">
            Not yet read by Capiro:{' '}
            {notWired.map((s, i) => (
              <span key={s.source}>
                {i > 0 ? ', ' : ''}
                <span title={s.explanation} style={{ textDecoration: 'underline dotted' }}>
                  {LANDSCAPE_SOURCE_LABELS[s.source] ?? s.source}
                </span>
              </span>
            ))}
            . Their absence here says nothing about whether they hold anything.
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <FovCard title="Government landscape" testId="fo-detail-landscape">
      {body()}
    </FovCard>
  );
}
