import { Button, Card, Dropdown, Space, Tag, Tooltip, Typography } from 'antd';
import {
  BookOutlined,
  CloseOutlined,
  EllipsisOutlined,
  ExportOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  ELIGIBILITY_LABELS,
  KIND_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  moneyLine,
  type FundingOpportunity,
} from './funding-opportunities-api.js';

const { Text, Paragraph } = Typography;

/**
 * One opportunity row.
 *
 * ── The two things this component exists to keep honest ──────────────────────
 *
 * RELEVANCE AND ELIGIBILITY ARE TWO SEPARATE BADGES. They answer different
 * questions ("is this your kind of work" vs "may you apply"), and an opportunity
 * can be a perfect thematic match the client is legally barred from. Merging them
 * into one score would turn "you are barred from this" into "this is a weak
 * match".
 *
 * MONEY COMES FROM `moneyLine`, WHICH IS SOURCE-AWARE. A grant shows an award
 * ceiling or a program total, a SAM notice shows "Not stated" — never `$0`, and
 * never a blended figure.
 */
export interface OpportunityCardProps {
  opportunity: FundingOpportunity;
  /** Absent when no client is selected: workflow actions need a client. */
  clientId: string | null;
  onSave?: (o: FundingOpportunity) => void;
  onPursue?: (o: FundingOpportunity) => void;
  onDismiss?: (o: FundingOpportunity) => void;
  onRestore?: (o: FundingOpportunity) => void;
  onAssign?: (o: FundingOpportunity) => void;
  onNote?: (o: FundingOpportunity) => void;
  onLinkSite?: (o: FundingOpportunity) => void;
  onCreateTask?: (o: FundingOpportunity) => void;
  busy?: boolean;
}

const ELIGIBILITY_COLOR: Record<string, string> = {
  eligible: 'green',
  ineligible: 'red',
  needs_review: 'orange',
  unknown: 'default',
};

const WORKFLOW_COLOR: Record<string, string> = {
  suggested: 'default',
  saved: 'blue',
  pursuing: 'geekblue',
  dismissed: 'default',
  won: 'green',
  lost: 'red',
  expired: 'default',
};

const STRENGTH_COLOR: Record<string, string> = {
  strong: 'green',
  moderate: 'blue',
  weak: 'default',
};

export function OpportunityCard({
  opportunity: o,
  clientId,
  onSave,
  onPursue,
  onDismiss,
  onRestore,
  onAssign,
  onNote,
  onLinkSite,
  onCreateTask,
  busy,
}: OpportunityCardProps) {
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const money = moneyLine(o);
  const dismissed = o.workflow?.status === 'dismissed';
  const canAct = Boolean(clientId);

  // An amended notice must not read as an original one.
  const showBaseKind = o.baseKind != null && o.baseKind !== o.kind;

  return (
    <Card
      size="small"
      className="fo-card"
      data-testid={`fo-card-${o.id}`}
      aria-label={`${SOURCE_LABELS[o.source]} ${KIND_LABELS[o.kind]}: ${o.title}`}
    >
      <div className="fo-card__head">
        <Space size={6} wrap>
          <Tag color={o.source === 'grants_gov' ? 'purple' : 'cyan'}>{SOURCE_LABELS[o.source]}</Tag>
          <Tag>
            {KIND_LABELS[o.kind]}
            {o.kind === 'other' && o.kindRaw ? ` · ${o.kindRaw}` : ''}
          </Tag>
          {showBaseKind ? (
            <Tooltip title="This notice was originally posted at an earlier stage. It is not an original solicitation.">
              <Tag color="gold">Was {KIND_LABELS[o.baseKind!]}</Tag>
            </Tooltip>
          ) : null}
          {!o.isPursuable ? (
            <Tooltip title="This notice is informational. It is not something you can respond to.">
              <Tag>Not a pursuit</Tag>
            </Tooltip>
          ) : null}
          {!o.isActive ? <Tag>Closed</Tag> : null}
          {o.workflow ? (
            <Tag color={WORKFLOW_COLOR[o.workflow.status]}>
              {WORKFLOW_LABELS[o.workflow.status]}
            </Tag>
          ) : null}
          {o.workflow?.staleAt ? (
            <Tooltip title="The nightly matcher no longer suggests this, but your decision on it stands.">
              <Tag>No longer suggested</Tag>
            </Tooltip>
          ) : null}
        </Space>
      </div>

      <div className="fo-card__title">
        {o.sourceUrl ? (
          <a href={o.sourceUrl} target="_blank" rel="noreferrer">
            {o.title} <ExportOutlined aria-hidden />
          </a>
        ) : (
          <Text strong>{o.title}</Text>
        )}
      </div>

      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }}>
          {[o.agency, o.subAgency, o.office].filter(Boolean).join(' · ') || 'Agency not stated'}
          {o.sourceReference ? ` · ${o.sourceReference}` : ''}
        </Text>
      </div>

      <div className="fo-card__facts">
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Deadline
          </Text>
          <Text className="fo-fact__value">
            {deadline.text}
            {deadline.daysRemaining != null && deadline.daysRemaining >= 0 ? (
              <Text type={deadline.daysRemaining <= 14 ? 'danger' : 'secondary'} style={{ fontSize: 11 }}>
                {' '}
                ({deadline.daysRemaining}d)
              </Text>
            ) : null}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            {money.label}
          </Text>
          <Text className="fo-fact__value">{money.value}</Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Relevance
          </Text>
          <Text className="fo-fact__value">{o.relevanceScore}</Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Eligibility
          </Text>
          <Tooltip title={o.eligibility.reason}>
            <Tag color={ELIGIBILITY_COLOR[o.eligibility.state]}>
              {ELIGIBILITY_LABELS[o.eligibility.state]}
            </Tag>
          </Tooltip>
        </span>

        {o.setAside ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Set-aside
            </Text>
            <Text className="fo-fact__value">{o.setAside}</Text>
          </span>
        ) : null}

        {o.naicsCodes.length || o.pscCodes.length ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Codes
            </Text>
            <Text className="fo-fact__value">
              {[...o.naicsCodes.map((c) => `NAICS ${c}`), ...o.pscCodes.map((c) => `PSC ${c}`)].join(
                ' · ',
              )}
            </Text>
          </span>
        ) : null}

        {o.assistanceListings.length ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Assistance Listing
            </Text>
            <Text className="fo-fact__value">{o.assistanceListings.join(', ')}</Text>
          </span>
        ) : null}

        {o.workflow?.facility ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Project site
            </Text>
            <Text className="fo-fact__value">
              {o.workflow.facility.name}
              {o.workflow.facility.districtKey ? ` (${o.workflow.facility.districtKey})` : ''}
            </Text>
          </span>
        ) : null}

        {o.workflow?.owner ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Owner
            </Text>
            <Text className="fo-fact__value">
              {o.workflow.owner.name ?? o.workflow.owner.email ?? o.workflow.owner.userId}
            </Text>
          </span>
        ) : null}
      </div>

      {o.matchedSignals.length > 0 ? (
        <div className="fo-card__signals">
          <Text type="secondary" style={{ fontSize: 11 }}>
            Matched on:{' '}
          </Text>
          <Space size={4} wrap>
            {o.matchedSignals.map((s) => (
              <Tooltip
                key={`${s.signal}:${s.matchedOn}`}
                title={`${s.strength} signal · matched on "${s.matchedOn}"`}
              >
                <Tag color={STRENGTH_COLOR[s.strength]} style={{ fontSize: 11 }}>
                  {s.signal}: {s.matchedOn}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        </div>
      ) : null}

      {o.missingProfileFields.length > 0 ? (
        <div className="fo-card__gaps">
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

      {o.summary ? (
        o.summaryIsLink ? (
          // SAM's payload puts EITHER prose OR a link to its description endpoint
          // in this field. Rendering a URL as the synopsis looks like corrupt data.
          <Paragraph style={{ marginBottom: 0, fontSize: 12 }}>
            <a href={o.summary} target="_blank" rel="noreferrer">
              Read the full description on SAM.gov <ExportOutlined aria-hidden />
            </a>
          </Paragraph>
        ) : (
          <Paragraph
            type="secondary"
            style={{ marginBottom: 0, fontSize: 12 }}
            ellipsis={{ rows: 2, expandable: true, symbol: 'more' }}
          >
            {o.summary}
          </Paragraph>
        )
      ) : null}

      <div className="fo-card__actions">
        <Space size={6} wrap>
          {dismissed ? (
            <Button
              size="small"
              icon={<RollbackOutlined />}
              disabled={!canAct || busy}
              onClick={() => onRestore?.(o)}
            >
              Restore
            </Button>
          ) : (
            <>
              <Button
                size="small"
                icon={<BookOutlined />}
                disabled={!canAct || busy}
                onClick={() => onSave?.(o)}
              >
                Save
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                disabled={!canAct || busy}
                onClick={() => onPursue?.(o)}
              >
                Pursue
              </Button>
              <Button
                size="small"
                icon={<CloseOutlined />}
                disabled={!canAct || busy}
                onClick={() => onDismiss?.(o)}
              >
                Dismiss
              </Button>
            </>
          )}
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'assign', label: 'Assign owner', disabled: !canAct },
                { key: 'note', label: 'Add note', disabled: !canAct },
                { key: 'site', label: 'Link project site', disabled: !canAct },
                { key: 'task', label: 'Create task', disabled: !canAct },
                ...(o.sourceUrl ? [{ key: 'source', label: 'Open source notice' }] : []),
              ],
              onClick: ({ key }) => {
                if (key === 'assign') onAssign?.(o);
                if (key === 'note') onNote?.(o);
                if (key === 'site') onLinkSite?.(o);
                if (key === 'task') onCreateTask?.(o);
                if (key === 'source' && o.sourceUrl) window.open(o.sourceUrl, '_blank', 'noreferrer');
              },
            }}
          >
            <Button size="small" icon={<EllipsisOutlined />} aria-label={`More actions for ${o.title}`} />
          </Dropdown>
        </Space>
        {!canAct ? (
          <Text type="secondary" style={{ fontSize: 11 }}>
            Select a client to save or pursue.
          </Text>
        ) : null}
      </div>
    </Card>
  );
}
