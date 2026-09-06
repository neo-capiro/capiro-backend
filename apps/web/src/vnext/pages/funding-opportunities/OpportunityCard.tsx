import { useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
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
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import {
  FIT_BAND_COLORS,
  FIT_BAND_LABELS,
  explainSignals,
} from '../../../pages/intelligence/opportunities/opportunity-explanations.js';
import { FovActionsMenu, FovCard, FovDisclosure, FovPill } from './fov-ui.js';

/**
 * One opportunity row — vNext port of the canonical OpportunityCard.
 *
 * Same two honesty rules, verbatim:
 *
 * RELEVANCE AND ELIGIBILITY ARE TWO SEPARATE BADGES. They answer different
 * questions ("is this your kind of work" vs "may you apply"), and an
 * opportunity can be a perfect thematic match the client is legally barred
 * from.
 *
 * MONEY COMES FROM `moneyLine`, WHICH IS SOURCE-AWARE. A grant shows an award
 * ceiling or a program total, a SAM notice shows "Not stated" — never `$0`,
 * and never a blended figure.
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

/**
 * `related_entity_access`/`known_teaming_route` share a colour, deliberately
 * DIFFERENT from `direct_prime_access` — "your parent can bid" must never look
 * like "you can bid" at a glance.
 */
const ACQUISITION_POSITION_COLOR: Record<AcquisitionPositionState, string> = {
  direct_prime_access: 'green',
  related_entity_access: 'blue',
  known_teaming_route: 'blue',
  vehicle_not_identified: 'default',
  no_direct_access_evidence: 'default',
  unknown: 'default',
};

/** External-link glyph, mirroring the shared icon set's stroke conventions. */
function ExternalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: '-1px' }}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

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
   * Signals turned into words, sorted strongest-first HERE rather than trusted
   * from the response — the leading reason cannot change because a payload
   * happened to serialise in a different order.
   */
  const explained = explainSignals(o.matchedSignals);
  const fitLabel = !clientId
    ? 'Not evaluated'
    : explained.strongest
      ? FIT_BAND_LABELS[explained.fitBand]
      : 'No fit evidence';

  /**
   * Can this notice be PURSUED at all? Buttons are HIDDEN rather than
   * disabled for informational/closed notices: a disabled Pursue invites "why
   * can't I?", whereas the adjacent explanatory pill already answers it.
   * Save, Dismiss and Ask Meri stay available.
   */
  const canPursue = o.isPursuable && o.isActive;

  // An amended notice must not read as an original one.
  const showBaseKind = o.baseKind != null && o.baseKind !== o.kind;

  // The SAM/Grants synopsis, clamped to two lines with an explicit toggle
  // (vNext replacement for antd Paragraph's ellipsis/expandable).
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  return (
    <FovCard
      className="fov-opportunity-card"
      testId={`fo-card-${o.id}`}
      ariaLabel={`${SOURCE_LABELS[o.source]} ${KIND_LABELS[o.kind]}: ${o.title}`}
    >
      <div className="fov-card__head">
        <span className="fov-row">
          <FovPill tone={o.source === 'grants_gov' ? 'purple' : 'cyan'}>
            {SOURCE_LABELS[o.source]}
          </FovPill>
          <FovPill>
            {KIND_LABELS[o.kind]}
            {o.kind === 'other' && o.kindRaw ? ` · ${o.kindRaw}` : ''}
          </FovPill>
          {showBaseKind ? (
            <FovPill
              tone="gold"
              title="This notice was originally posted at an earlier stage. It is not an original solicitation."
            >
              Was {KIND_LABELS[o.baseKind!]}
            </FovPill>
          ) : null}
          {!o.isPursuable ? (
            <FovPill title="This notice is informational. It is not something you can respond to.">
              Not a pursuit
            </FovPill>
          ) : null}
          {!o.isActive ? <FovPill>Closed</FovPill> : null}
          {o.workflow ? (
            <FovPill tone={WORKFLOW_COLOR[o.workflow.status]}>
              {WORKFLOW_LABELS[o.workflow.status]}
            </FovPill>
          ) : null}
          {o.workflow?.staleAt ? (
            <FovPill title="The nightly matcher no longer suggests this, but your decision on it stands.">
              No longer suggested
            </FovPill>
          ) : null}
        </span>
      </div>

      <div className="fov-card__title">
        {o.sourceUrl ? (
          <a href={o.sourceUrl} target="_blank" rel="noreferrer">
            {o.title} <ExternalIcon />
          </a>
        ) : (
          <strong>{o.title}</strong>
        )}
      </div>

      <div className="fov-card__meta">
        <span className="fov-muted">
          {[o.agency, o.subAgency, o.office].filter(Boolean).join(' · ') || 'Agency not stated'}
          {o.sourceReference ? ` · ${o.sourceReference}` : ''}
        </span>
      </div>

      <div className="fov-card__facts">
        <span className="fov-fact">
          <span className="fov-fact__label">Deadline</span>
          <span className="fov-fact__value">
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
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">{money.label}</span>
          <span className="fov-fact__value">{money.value}</span>
        </span>

        {/*
          A FIT BAND, not a bare number. The band comes from the STRONGEST
          signal, never from a count — five weak word-hits cannot out-rank one
          exact NAICS match. The numeric score lives in the evidence disclosure.
        */}
        <span className="fov-fact">
          <span className="fov-fact__label">Fit</span>
          <FovPill
            tone={FIT_BAND_COLORS[explained.fitBand]}
            ariaLabel={`Fit: ${fitLabel}`}
            title={
              explained.strongest
                ? `${explained.strongest.label} — matched on "${explained.strongest.matchedOn}"`
                : 'No matching signals against this client’s recorded profile.'
            }
          >
            {fitLabel}
          </FovPill>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Eligibility</span>
          <FovPill tone={ELIGIBILITY_COLOR[o.eligibility.state]} title={o.eligibility.reason}>
            {ELIGIBILITY_LABELS[o.eligibility.state]}
          </FovPill>
        </span>

        {/* Shown ONLY when a position exists — the detail panel is where
            "why is this missing" gets explained. */}
        {o.acquisitionPosition ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Vehicle access</span>
            <FovPill
              tone={ACQUISITION_POSITION_COLOR[o.acquisitionPosition.state]}
              title={o.acquisitionPosition.summary}
            >
              {ACQUISITION_POSITION_LABELS[o.acquisitionPosition.state]}
            </FovPill>
          </span>
        ) : null}

        {o.setAside ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Set-aside</span>
            <span className="fov-fact__value">{o.setAside}</span>
          </span>
        ) : null}

        {o.naicsCodes.length || o.pscCodes.length ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Codes</span>
            <span className="fov-fact__value">
              {[
                ...o.naicsCodes.map((c) => `NAICS ${c}`),
                ...o.pscCodes.map((c) => `PSC ${c}`),
              ].join(' · ')}
            </span>
          </span>
        ) : null}

        {o.assistanceListings.length ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Assistance Listing</span>
            <span className="fov-fact__value">{o.assistanceListings.join(', ')}</span>
          </span>
        ) : null}

        {o.workflow?.facility ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Project site</span>
            <span className="fov-fact__value">
              {o.workflow.facility.name}
              {o.workflow.facility.districtKey ? ` (${o.workflow.facility.districtKey})` : ''}
            </span>
          </span>
        ) : null}

        {o.workflow?.owner ? (
          <span className="fov-fact">
            <span className="fov-fact__label">Owner</span>
            <span className="fov-fact__value">
              {o.workflow.owner.name ?? o.workflow.owner.email ?? o.workflow.owner.userId}
            </span>
          </span>
        ) : null}
      </div>

      {/* The strongest reason, in words, as the card's default evidence line.
          Every label names the matched VALUE, so an operator can go check it. */}
      {explained.strongest ? (
        <div className="fov-card__signals">
          <span className="fov-micro">Strongest reason</span>
          <FovPill
            tone={FIT_BAND_COLORS[explained.strongest.strength]}
            title={`Matched on "${explained.strongest.matchedOn}"`}
          >
            {explained.strongest.label}
          </FovPill>
          <span className="fov-card__signals-matched">
            matched on &quot;{explained.strongest.matchedOn}&quot;
          </span>
        </div>
      ) : null}

      {/* Fit evidence excludes eligibility context, which has its own status above. */}
      {explained.signals.length > 0 ? (
        <FovDisclosure
          className="fov-card__evidence"
          summary={
            <span className="fov-micro">
              Fit evidence ({explained.signals.length}) · relevance {o.relevanceScore}
            </span>
          }
        >
          <div className="fov-stack fov-stack--2">
            {explained.signals.map((s) => (
              <div key={`${s.signal}:${s.matchedOn}`} className="fov-row">
                <FovPill tone={FIT_BAND_COLORS[s.strength]}>{s.label}</FovPill>
                <span className="fov-micro">matched on “{s.matchedOn}”</span>
              </div>
            ))}
          </div>
        </FovDisclosure>
      ) : null}

      {o.missingProfileFields.length > 0 ? (
        <div className="fov-card__gaps">
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

      {o.summary ? (
        o.summaryIsLink ? (
          // SAM's payload puts EITHER prose OR a link to its description
          // endpoint in this field. Rendering a URL as the synopsis looks like
          // corrupt data.
          <p className="fov-muted" style={{ margin: 0 }}>
            <a href={o.summary} target="_blank" rel="noreferrer">
              Read the full description on SAM.gov <ExternalIcon />
            </a>
          </p>
        ) : (
          <p className="fov-muted" style={{ margin: 0 }}>
            <span className={summaryExpanded ? undefined : 'fov-summary--clamped'}>
              {o.summary}
            </span>{' '}
            {!summaryExpanded ? (
              <button
                type="button"
                className="fov-summary-toggle"
                onClick={() => setSummaryExpanded(true)}
              >
                more
              </button>
            ) : null}
          </p>
        )
      ) : null}

      <div className="fov-card__actions">
        <span className="fov-row">
          {dismissed ? (
            <CapiroButton size="compact" disabled={!canAct || busy} onClick={() => onRestore?.(o)}>
              Restore
            </CapiroButton>
          ) : (
            <>
              <CapiroButton size="compact" disabled={!canAct || busy} onClick={() => onSave?.(o)}>
                Save
              </CapiroButton>
              {canPursue ? (
                <CapiroButton
                  size="compact"
                  variant="primary"
                  disabled={!canAct || busy}
                  onClick={() => onPursue?.(o)}
                >
                  Pursue
                </CapiroButton>
              ) : null}
              <CapiroButton
                size="compact"
                disabled={!canAct || busy}
                onClick={() => onAskMeri?.(o)}
              >
                Ask Meri
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={!canAct || busy}
                onClick={() => onDismiss?.(o)}
              >
                Dismiss
              </CapiroButton>
            </>
          )}
          <FovActionsMenu
            label={`More actions for ${o.title}`}
            items={[
              // These three work on an UNSAVED recommendation — the API creates
              // the `saved` row as part of the edit, because assigning an owner
              // to something is how a human takes responsibility for it.
              { key: 'assign', label: 'Assign owner', disabled: !canAct },
              { key: 'note', label: 'Add note', disabled: !canAct },
              { key: 'site', label: 'Link project site', disabled: !canAct },
              // A pursuit task is a pursuit action, so it follows Pursue.
              ...(canPursue ? [{ key: 'task', label: 'Create task', disabled: !canAct }] : []),
              ...(o.sourceUrl ? [{ key: 'source', label: 'Open source notice' }] : []),
            ]}
            onSelect={(key) => {
              if (key === 'assign') onAssign?.(o);
              if (key === 'note') onNote?.(o);
              if (key === 'site') onLinkSite?.(o);
              if (key === 'task') onCreateTask?.(o);
              if (key === 'source' && o.sourceUrl) window.open(o.sourceUrl, '_blank', 'noreferrer');
            }}
          />
        </span>
        {!canAct ? (
          <span className="fov-micro">Select a client to save or pursue.</span>
        ) : !canPursue && !dismissed ? (
          <span className="fov-micro">
            {o.isPursuable
              ? 'This notice is closed, so it can be saved for reference but not pursued.'
              : 'This notice is informational, so it can be saved for reference but not pursued.'}
          </span>
        ) : null}
      </div>
    </FovCard>
  );
}
