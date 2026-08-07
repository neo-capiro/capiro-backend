import { Button, Card, Collapse, Dropdown, Space, Tag, Tooltip, Typography } from 'antd';
import {
  BookOutlined,
  CloseOutlined,
  EllipsisOutlined,
  ExportOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import {
  ACQUISITION_POSITION_LABELS,
  ELIGIBILITY_LABELS,
  KIND_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  moneyLine,
  type AcquisitionPositionState,
  type FundingOpportunity,
} from './funding-opportunities-api.js';
import {
  FIT_BAND_COLORS,
  FIT_BAND_LABELS,
  explainSignals,
} from './opportunity-explanations.js';

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
  onAskMeri?: (o: FundingOpportunity) => void;
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

/**
 * `related_entity_access`/`known_teaming_route` share a color, deliberately
 * DIFFERENT from `direct_prime_access` — see AcquisitionPositionPanel.tsx's
 * own doc for why the two must never look the same at a glance.
 */
const ACQUISITION_POSITION_COLOR: Record<AcquisitionPositionState, string> = {
  direct_prime_access: 'green',
  related_entity_access: 'blue',
  known_teaming_route: 'blue',
  vehicle_not_identified: 'default',
  no_direct_access_evidence: 'default',
  unknown: 'default',
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
  onAskMeri,
  busy,
}: OpportunityCardProps) {
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const money = moneyLine(o);
  const dismissed = o.workflow?.status === 'dismissed';
  const canAct = Boolean(clientId);
  /**
   * Signals turned into words, sorted strongest-first HERE rather than trusted from
   * the response — so the leading reason cannot change because a payload happened
   * to serialise in a different order.
   */
  const explained = explainSignals(o.matchedSignals);

  /**
   * Can this notice be PURSUED at all?
   *
   * The card already labelled informational and closed notices ("Not a pursuit",
   * "Closed") but still offered Pursue and Create task next to the label, and the
   * API accepted both. So an award notice — a competition somebody else has
   * already won — could be marked as an active pursuit and would then sort to the
   * TOP of the workflow rail, above real bids. The buttons are HIDDEN rather than
   * disabled: a disabled Pursue invites "why can't I?", whereas the adjacent
   * explanatory tag already answers it.
   *
   * Save, Dismiss and Ask Meri stay available. Saving a competitor's win for
   * reference is legitimate; claiming to be bidding it is not.
   */
  const canPursue = o.isPursuable && o.isActive;

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

        {/*
          A FIT BAND, not a bare number. "Relevance 62" is not a claim anybody can
          check or dispute; "Strong fit" plus the reason below is. The number itself
          moves to the evidence panel — kept, because an operator auditing a match
          needs it, just not as the headline.

          The band comes from the STRONGEST signal, never from a count, so five
          weak word-hits cannot out-rank one exact NAICS match.
        */}
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Fit
          </Text>
          <Tooltip
            title={
              explained.strongest
                ? `${explained.strongest.label} — matched on "${explained.strongest.matchedOn}"`
                : 'No matching signals against this client’s recorded profile.'
            }
          >
            <Tag color={FIT_BAND_COLORS[explained.fitBand]} aria-label={`Fit: ${FIT_BAND_LABELS[explained.fitBand]}`}>
              {FIT_BAND_LABELS[explained.fitBand]}
            </Tag>
          </Tooltip>
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

        {/*
          Concise: shown ONLY when a position exists. A grant, an unscored
          catalog row, or the vehicle-fit flag being off all render nothing
          extra here — the detail panel is where "why is this missing" gets
          explained, matching how missingProfileFields and the strongest-
          signal line already behave on this same card.
        */}
        {o.acquisitionPosition ? (
          <span className="fo-fact">
            <Text type="secondary" className="fo-fact__label">
              Vehicle access
            </Text>
            <Tooltip title={o.acquisitionPosition.summary}>
              <Tag color={ACQUISITION_POSITION_COLOR[o.acquisitionPosition.state]}>
                {ACQUISITION_POSITION_LABELS[o.acquisitionPosition.state]}
              </Tag>
            </Tooltip>
          </span>
        ) : null}

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

      {/*
        The strongest reason, in words, as the card's default evidence line. It used
        to print `{s.signal}: {s.matchedOn}` for every signal — so `naicsExact` and
        `genericTopical` appeared as identical-looking bullets, and a reader could
        not tell an exact classification match from the word "defense" turning up in
        a DoD notice.

        Every label names the matched VALUE, because the point of matchedOn is that
        an operator can go and check it.
      */}
      {explained.strongest ? (
        <div className="fo-card__signals">
          <Text type="secondary" style={{ fontSize: 11 }}>
            Strongest reason:{' '}
          </Text>
          <Tooltip title={`Matched on "${explained.strongest.matchedOn}"`}>
            <Tag color={FIT_BAND_COLORS[explained.strongest.strength]} style={{ fontSize: 11 }}>
              {explained.strongest.label}: {explained.strongest.matchedOn}
            </Tag>
          </Tooltip>
        </div>
      ) : null}

      {/*
        The full evidence, behind a disclosure. Nothing is hidden — the numeric
        relevance and every signal including the weak ones are here, because an
        operator judging a match needs to see that most of the evidence was thin.
        They are just not what the card leads with.
      */}
      {o.matchedSignals.length > 0 ? (
        <Collapse
          ghost
          size="small"
          className="fo-card__evidence"
          items={[
            {
              key: 'evidence',
              label: (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Evidence ({o.matchedSignals.length}) · relevance {o.relevanceScore}
                </Text>
              ),
              children: (
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  {explained.signals.map((s) => (
                    <div key={`${s.signal}:${s.matchedOn}`}>
                      <Tag color={FIT_BAND_COLORS[s.strength]} style={{ fontSize: 11 }}>
                        {s.label}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        matched on “{s.matchedOn}”
                      </Text>
                      {/* The raw key, for anyone reconciling against the scorer. */}
                      <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }} code>
                        {s.signal}
                      </Text>
                    </div>
                  ))}
                </Space>
              ),
            },
          ]}
        />
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
              {canPursue ? (
                <Button
                  size="small"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  disabled={!canAct || busy}
                  onClick={() => onPursue?.(o)}
                >
                  Pursue
                </Button>
              ) : null}
              <Button
                size="small"
                icon={<MessageOutlined />}
                disabled={!canAct || busy}
                onClick={() => onAskMeri?.(o)}
              >
                Ask Meri
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
                // These three work on an UNSAVED recommendation — the API creates
                // the `saved` row as part of the edit, because assigning an owner
                // to something is how a human takes responsibility for it.
                { key: 'assign', label: 'Assign owner', disabled: !canAct },
                { key: 'note', label: 'Add note', disabled: !canAct },
                { key: 'site', label: 'Link project site', disabled: !canAct },
                // A pursuit task is a pursuit action, so it follows Pursue.
                ...(canPursue ? [{ key: 'task', label: 'Create task', disabled: !canAct }] : []),
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
        ) : !canPursue && !dismissed ? (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {o.isPursuable
              ? 'This notice is closed, so it can be saved for reference but not pursued.'
              : 'This notice is informational, so it can be saved for reference but not pursued.'}
          </Text>
        ) : null}
      </div>
    </Card>
  );
}
