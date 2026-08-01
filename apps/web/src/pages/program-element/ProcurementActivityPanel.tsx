import { Alert, Card, Empty, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { OpportunityItem } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text, Paragraph } = Typography;

export interface ProcurementActivityPanelProps {
  opportunities: OpportunityItem[] | null | undefined;
  loading?: boolean;

  errored?: boolean;
  onRetry?: () => void;
}

/** Tag color for a SAM.gov notice type (best-effort; defaults to antd's default). */
const NOTICE_TYPE_COLOR: Record<string, string> = {
  solicitation: 'blue',
  'combined synopsis/solicitation': 'blue',
  presolicitation: 'geekblue',
  'sources sought': 'purple',
  'award notice': 'green',
  'special notice': 'gold',
};

export function noticeTypeColor(noticeType: string): string {
  return NOTICE_TYPE_COLOR[noticeType.trim().toLowerCase()] ?? 'default';
}

/**
 * Human deadline countdown from an ISO responseDeadline, relative to `now`.
 *   - null deadline           -> { label: 'No deadline', tone: 'default' }
 *   - deadline already passed  -> { label: 'closed',      tone: 'default' }
 *   - closes today             -> { label: 'closes today', tone: 'red' }
 *   - 1..7 days out            -> { label: 'closes in Nd', tone: 'red'/'orange' }
 *   - further out              -> { label: 'closes in Nd', tone: 'green' }
 * `now` is injectable so the deterministic test does not depend on the wall clock.
 */
export function deadlineCountdown(
  responseDeadline: string | null,
  now: Date = new Date(),
): { label: string; tone: string } {
  if (!responseDeadline) return { label: 'No deadline', tone: 'default' };
  const deadline = new Date(responseDeadline);
  if (Number.isNaN(deadline.getTime())) return { label: 'No deadline', tone: 'default' };

  const ms = deadline.getTime() - now.getTime();
  if (ms < 0) return { label: 'closed', tone: 'default' };

  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return { label: 'closes today', tone: 'red' };
  const label = `closes in ${days}d`;
  if (days <= 3) return { label, tone: 'red' };
  if (days <= 7) return { label, tone: 'orange' };
  return { label, tone: 'green' };
}

/** Display date (YYYY-MM-DD) from an ISO string, or null. */
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Step 3.1 — PE profile "Procurement activity" panel. Renders ACTIVE SAM.gov
 * procurement notices linked to this Program Element: the notice type, the title
 * (deep-linked to the SAM.gov listing), the issuing agency · office, a live
 * DEADLINE COUNTDOWN ("closes in 12d" / "closed"), and — for machine-matched
 * notices awaiting review — a "Candidate — review" tag.
 *
 * GUARDRAIL: each notice's procurement point-of-contact (pocName/pocEmail) is
 * rendered with an explicit "Official procurement POC" badge AND a plain-language
 * note that it is a contracting contact, NOT a lobbying/outreach target. The POC
 * is shown for provenance only and is NEVER presented as someone to reach out to.
 *
 * Guards against non-array data with Array.isArray. Honest empty state. Tolerates
 * null deadlines and a missing POC without crashing.
 */
export function ProcurementActivityPanel({
  opportunities,
  loading = false,
  errored = false,
  onRetry,
}: ProcurementActivityPanelProps) {
  if (loading) {
    return (
      <Card title="Procurement activity">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="procurement opportunities" testId="pe-secondary-failed-opportunities" onRetry={onRetry} />
    );
  }


  const rows = Array.isArray(opportunities) ? opportunities : [];

  if (rows.length === 0) {
    return (
      <Card className="pe-opportunities-card" title="Procurement activity">
        <Empty description="No active procurement notices linked to this PE yet — populated as SAM.gov solicitations are matched." />
      </Card>
    );
  }

  return (
    <Card className="pe-opportunities-card" title={`Procurement activity · ${rows.length}`}>
      <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
        Active SAM.gov procurement notices that touch this Program Element — the contracting
        opportunity, the issuing office, and how long until it closes. Candidate rows are
        machine-matched and await review.
      </Paragraph>

      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {rows.map((o) => {
          const countdown = deadlineCountdown(o.responseDeadline);
          const posted = shortDate(o.postedDate);
          const due = shortDate(o.responseDeadline);
          const orgLine = [o.agency, o.office].filter(Boolean).join(' · ');
          const hasPoc = Boolean(o.pocName || o.pocEmail);
          return (
            <div key={o.id} style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}>
              <Space wrap size={[6, 4]} style={{ marginBottom: 4 }}>
                <Tag color={noticeTypeColor(o.noticeType)}>{o.noticeType}</Tag>
                <Tag color={countdown.tone}>{countdown.label}</Tag>
                {o.pscCode ? <Tag>PSC {o.pscCode}</Tag> : null}
                {o.naicsCode ? <Tag>NAICS {o.naicsCode}</Tag> : null}
                {o.reviewStatus === 'candidate' ? <Tag color="gold">Candidate — review</Tag> : null}
              </Space>

              <div>
                {o.sourceUrl ? (
                  <a href={o.sourceUrl} target="_blank" rel="noreferrer">
                    <Text strong>{o.title}</Text>
                  </a>
                ) : (
                  <Text strong>{o.title}</Text>
                )}
              </div>

              {orgLine ? (
                <div>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {orgLine}
                  </Text>
                </div>
              ) : null}

              <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>
                {posted ? `Posted ${posted}` : null}
                {posted && due ? ' · ' : null}
                {due ? `Response due ${due}` : null}
              </div>

              {hasPoc ? (
                <div style={{ marginTop: 6 }}>
                  <Space wrap size={[6, 4]} style={{ marginBottom: 2 }}>
                    <Tooltip title="Procurement contact — not a lobbying target">
                      <Tag color="default">Official procurement POC</Tag>
                    </Tooltip>
                    {o.pocName ? <Text style={{ fontSize: 13 }}>{o.pocName}</Text> : null}
                    {o.pocEmail ? (
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        {o.pocEmail}
                      </Text>
                    ) : null}
                  </Space>
                  <Alert
                    type="info"
                    showIcon
                    style={{ padding: '2px 8px', fontSize: 12 }}
                    message="This is the official procurement contact — not a lobbying target."
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default ProcurementActivityPanel;
