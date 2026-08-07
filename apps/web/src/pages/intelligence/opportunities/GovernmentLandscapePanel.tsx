import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE,
  LANDSCAPE_SOURCE_LABELS,
  landscapeApiPath,
  type LandscapePacketView,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/**
 * Capiro's own government-affairs context for one client-opportunity pair (P33).
 *
 * ── Verified and inferred look different, because they are different ─────────
 *
 * Every item carries a basis. `source_backed` means a source states the link —
 * a reviewed and accepted Program Element match, a facility the client
 * recorded. `inferred` means two things resemble each other, which is what a
 * NAICS or keyword coincidence produces.
 *
 * An inferred item is rendered with a distinct badge AND a sentence saying it is
 * not evidence of a link. Badges alone are not enough: a reader scanning a list
 * reads the text, and a quarantined PE match that looks like an accepted one
 * with a different colour is the specific misreading this panel exists to
 * prevent.
 *
 * ── A source Capiro cannot read yet makes no claim ───────────────────────────
 *
 * Every declared source is listed with its state, and `not_wired` is worded so
 * it cannot be read as a finding: "Nothing here says none exist." An unwired
 * source contributes no section — an empty "Hearings" heading is a claim about
 * Congress that this packet cannot support.
 *
 * `empty` is a different state and gets a different sentence, because "Capiro
 * looked and found nothing" IS a finding.
 *
 * ── Coverage is not confidence ───────────────────────────────────────────────
 *
 * The coverage line says how many sources contributed out of how many Capiro
 * can read, and how many it eventually will. A packet can be fully covered and
 * contain nothing, which means Capiro looked everywhere it can and found no
 * connection — useful, and not the same as a low-confidence guess.
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
        <Text type="secondary" style={{ fontSize: 12 }}>
          Government landscape context is composed for SAM.gov contract opportunities. A grant’s
          programme context lives on the client’s own intelligence surface.
        </Text>
      );
    }
    if (clientId == null) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-landscape-unscored">
          Not composed without a client. The landscape is a fact about a client-opportunity pair,
          not about the notice.
        </Text>
      );
    }
    if (!flag.ready) return <Skeleton active paragraph={{ rows: 3 }} />;
    if (!flag.enabled) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-landscape-not-enabled">
          Government landscape context is not enabled for this workspace. This says nothing about
          what context exists for this opportunity.
        </Text>
      );
    }
    if (query.isPending) return <Skeleton active paragraph={{ rows: 4 }} />;
    if (query.isError) {
      return (
        <Alert
          type="error"
          showIcon
          data-testid="fo-landscape-error"
          message="Government landscape failed to load"
          description="This is a request failure, not an absence of context. Nothing follows from it about this opportunity."
        />
      );
    }

    const packet = query.data;
    const notWired = packet.sources.filter((s) => s.state === 'not_wired');
    const emptied = packet.sources.filter((s) => s.state === 'empty');

    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {packet.items.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-landscape-empty">
            No government-affairs context connects this client to this opportunity in the sources
            Capiro reads today. That is an absence of a connection, not evidence against pursuing.
          </Text>
        ) : (
          packet.items.map((item) => (
            <div key={`${item.source}:${item.sourceId}`} data-testid={`fo-landscape-item-${item.sourceId}`}>
              <Space size={6} wrap>
                <Tag>{LANDSCAPE_SOURCE_LABELS[item.source] ?? item.source}</Tag>
                {item.basis === 'source_backed' ? (
                  <Tag color="green">Verified</Tag>
                ) : (
                  <Tooltip title="Two things resemble each other. Nobody has reviewed the link, and it is excluded from every high-confidence action.">
                    <Tag color="orange">Inferred — not reviewed</Tag>
                  </Tooltip>
                )}
                <Text type="secondary" style={{ fontSize: 11 }}>
                  matched on “{item.matchedOn}”
                </Text>
              </Space>
              <div>
                <Text style={{ fontSize: 12 }}>{item.label}</Text>
              </div>
            </div>
          ))
        )}

        <div data-testid="fo-landscape-coverage">
          <Text type="secondary" style={{ fontSize: 11 }}>
            {/*
              Coverage, never confidence. A fully-covered packet can be empty —
              Capiro looked everywhere it can and found no connection.
            */}
            {packet.coverage.available} of {packet.coverage.wired} readable sources contributed;{' '}
            {packet.coverage.declared} are planned in total.
          </Text>
        </div>

        {emptied.length > 0 ? (
          <Text type="secondary" style={{ fontSize: 11 }} data-testid="fo-landscape-empty-sources">
            Read and holding nothing for this pair:{' '}
            {emptied.map((s) => LANDSCAPE_SOURCE_LABELS[s.source] ?? s.source).join(', ')}.
          </Text>
        ) : null}

        {notWired.length > 0 ? (
          <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 0 }} data-testid="fo-landscape-not-wired">
            Not yet read by Capiro:{' '}
            {notWired.map((s, i) => (
              <span key={s.source}>
                {i > 0 ? ', ' : ''}
                <Tooltip title={s.explanation}>
                  <span style={{ textDecoration: 'underline dotted' }}>
                    {LANDSCAPE_SOURCE_LABELS[s.source] ?? s.source}
                  </span>
                </Tooltip>
              </span>
            ))}
            . Their absence here says nothing about whether they hold anything.
          </Paragraph>
        ) : null}
      </Space>
    );
  };

  return (
    <Card
      size="small"
      title="Government landscape"
      className="fo-detail__section"
      data-testid="fo-detail-landscape"
    >
      {body()}
    </Card>
  );
}
