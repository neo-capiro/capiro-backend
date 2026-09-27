import { useRef, useState } from 'react';
import type { FundingOpportunityV2DateFact, OpportunitySearchRecordV2 } from '@capiro/shared';
import { CapiroButton } from '../../components/actions/index.js';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';
import {
  FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION,
  fundingOpportunityMatchSignalLabel,
  getFundingOpportunityDeadlinePresentation,
  getFundingOpportunityMatchPresentation,
  getFundingOpportunityV2StatusTags,
} from './funding-opportunities-v2-detail-types.js';

export type OpportunityResultAction = 'save' | 'pursue';
export type OpportunityMenuAction = 'follow_up' | 'assign_owner' | 'note' | 'copy_link';

export type SourceFact = {
  label: string;
  value: string;
  tone?: 'plain' | 'muted' | 'warning' | 'error';
};

type EvidenceItem = { label: string; value: string; tone?: string };

export type FundingOpportunityResultRow = OpportunitySearchRecordV2 & {
  workflow?: { status?: string | null; saved?: boolean; stage?: string | null } | null;
  responseDeadline?: string | null;
  responseDeadlineDays?: number | null;
  clientName?: string | null;
  clientInitials?: string | null;
  clientCapability?: {
    state: 'eligible' | 'ineligible' | 'needs_review' | 'unknown';
    allowed: boolean;
    reason: string;
  } | null;
};

function savedState(row: FundingOpportunityResultRow): boolean {
  return row.decoration?.bookmark.saved ?? row.workflow?.saved ?? false;
}

function workflowStatus(row: FundingOpportunityResultRow): string | null {
  return row.decoration?.workflow.status ?? row.workflow?.status ?? null;
}

function workflowStage(row: FundingOpportunityResultRow): string | null {
  return row.decoration?.workflow.stage ?? row.workflow?.stage ?? null;
}

export interface FundingOpportunityV2ResultCardProps {
  row: FundingOpportunityResultRow;
  clientName?: string;
  matched: boolean;
  onOpenDetail: () => void;
  onQuick: () => void;
  onExternal: () => void;
  onClient?: () => void;
  onAction: (action: OpportunityResultAction) => void | Promise<void>;
  onNotFit?: (trigger?: HTMLElement) => void;
  onMenuAction?: (action: OpportunityMenuAction, trigger?: HTMLElement) => void | Promise<void>;
}

function sourceName(row: FundingOpportunityResultRow): string {
  return FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[row.source]?.label ?? row.source;
}

function sourceTone(row: FundingOpportunityResultRow): string {
  return FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[row.source]?.tone ?? 'plain';
}

const AGENCY_HISTORY_SIGNAL_IDS = new Set([
  'agencyhistory',
  'agency_history',
  'agency',
  'agencymatch',
  'agency history',
  'office history',
]);

function ruleTone(row: FundingOpportunityResultRow): string {
  if (row.source === 'agency_forecast' || row.lifecycle === 'forecast') return 'warn';
  if (row.matchedSignals.some((signal) =>
    AGENCY_HISTORY_SIGNAL_IDS.has(signal.signal.trim().toLowerCase()),
  )) return 'brand';
  return 'plain';
}

function sourceString(row: FundingOpportunityResultRow, key: string): string | null {
  const value = row.sourceFacts?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function sourceValue(row: FundingOpportunityResultRow, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row.sourceFacts?.[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function sourceText(row: FundingOpportunityResultRow, ...keys: string[]): string | null {
  const value = sourceValue(row, ...keys);
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function sourceFact(
  row: FundingOpportunityResultRow,
  key: string,
  fallback?: string | null,
): FundingOpportunityV2DateFact | null {
  const value = row.sourceFacts?.[key];
  if (value && typeof value === 'object') return value as FundingOpportunityV2DateFact;
  if (typeof value === 'string' || typeof value === 'number') {
    const scalar = String(value);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(scalar);
    const parseable = /^\d{4}-\d{2}-\d{2}/.test(scalar);
    const explicitZone =
      scalar.match(
        /(?:T|\s)(?:\d{1,2}:\d{2}(?::\d{2})?\s*)?(Z|[+-]\d{2}:?\d{2}|[A-Z]{2,5})$/,
      )?.[1] ?? null;
    return {
      value: fallback ?? scalar,
      precision: dateOnly ? 'date' : parseable ? 'timestamp' : fallback ? null : 'raw',
      timezone: sourceText(row, `${key}Timezone`) ?? explicitZone,
      sourceRaw: scalar,
      unavailableReason: null,
    };
  }
  return fallback
    ? {
        value: fallback,
        precision: null,
        timezone: sourceText(row, `${key}Timezone`),
        sourceRaw: null,
        unavailableReason: null,
      }
    : null;
}

function formatDate(value: string | null | undefined, includeYear = true): string {
  if (!value) return 'Not provided by source';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: dateOnly ? 'UTC' : undefined,
  });
}

function publicReference(row: FundingOpportunityResultRow): string {
  return (
    sourceString(row, 'sourceReference') ??
    sourceText(row, 'solicitation') ??
    sourceText(row, 'topicNumber') ??
    row.decoration?.workflow.publicReference ??
    sourceString(row, 'solicitationNumber') ??
    sourceString(row, 'opportunityNumber') ??
    sourceString(row, 'portalId') ??
    sourceString(row, 'externalId') ??
    sourceString(row, 'noticeId') ??
    'Source reference not provided'
  );
}

function formatMoney(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))
  ) {
    return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  return String(value);
}

function displayValue(row: FundingOpportunityResultRow): string {
  if (row.value == null) {
    return row.valueBasis === 'not_stated_by_source'
      ? 'Not stated by source'
      : 'Not provided by source';
  }
  return formatMoney(row.value) ?? 'Not provided by source';
}

function factsFor(row: FundingOpportunityResultRow): SourceFact[] {
  const facts: SourceFact[] = [];
  const add = (label: string, value: unknown, tone: SourceFact['tone'] = 'plain') => {
    if (value == null || value === '') return;
    facts.push({ label, value: String(value), tone });
  };
  const factDate = (key: string, fallback?: string | null) => {
    const fact = sourceFact(row, key, fallback);
    return formatDate(fact?.value ?? fallback);
  };
  if (row.source === 'agency_forecast') {
    add('Forecast published', factDate('postedDate', row.postedDate));
    add('Estimated value', displayValue(row), row.value == null ? 'muted' : 'plain');
    add(
      'Place of performance',
      row.geography.join(', ') || 'Not provided by source',
      row.geography.length ? 'plain' : 'muted',
    );
    add(
      'Agency status',
      sourceString(row, 'status') ?? 'Not provided by source',
      sourceString(row, 'status') ? 'plain' : 'muted',
    );
    add(
      'Last updated',
      factDate(
        'sourceUpdated',
        sourceText(row, 'sourceUpdatedAt', 'lastUpdatedDate', 'lastUpdatedRaw'),
      ),
    );
    return facts;
  }
  add('Posted', factDate('postedDate', row.postedDate));
  if (row.source === 'dibbs') {
    add(
      'Quantity',
      sourceText(row, 'quantity') && sourceText(row, 'unitOfIssue')
        ? `${sourceText(row, 'quantity')} ${sourceText(row, 'unitOfIssue')}`
        : (sourceText(row, 'quantity') ?? 'Not provided by source'),
      sourceText(row, 'quantity') ? 'plain' : 'muted',
    );
    add(
      'Set-aside',
      row.setAside ?? sourceText(row, 'setAside'),
      row.setAside || sourceText(row, 'setAside') ? 'plain' : 'muted',
    );
    add('Value', displayValue(row), row.value == null ? 'muted' : 'plain');
    add(
      'Place of performance',
      row.geography.join(', ') || 'Not provided by source',
      row.geography.length ? 'plain' : 'muted',
    );
    add(
      'Delivery',
      sourceText(row, 'delivery') ?? sourceText(row, 'deliveryDays') ?? 'Not provided by source',
      sourceText(row, 'delivery') || sourceText(row, 'deliveryDays') ? 'plain' : 'muted',
    );
  } else if (
    row.source === 'grants_gov' ||
    row.source === 'ca_portal' ||
    row.source === 'sbir_sttr'
  ) {
    add(
      'Eligible applicant',
      sourceText(row, 'applicantEligibilityDesc', 'applicantTypeRaw') ??
        (row.applicantTypes.length ? row.applicantTypes.join(', ') : null) ??
        'Not provided by source',
      row.eligibility?.state === 'ineligible' ? 'error' : 'plain',
    );
    add('Category', sourceText(row, 'category', 'categoriesRaw') ?? 'Not provided by source');
    add(
      'Geography',
      row.geography.join(', ') || 'Not provided by source',
      row.geography.length ? 'plain' : 'muted',
    );
    const floor = formatMoney(sourceValue(row, 'awardFloor'));
    const ceiling = formatMoney(sourceValue(row, 'awardCeiling'));
    const economics =
      ceiling ??
      sourceText(row, 'estimatedAvailableFundsRaw', 'totalAvailable') ??
      (row.value != null ? displayValue(row) : null);
    add(
      ceiling ? 'Ceiling' : 'Value',
      economics ?? 'Not provided by source',
      economics ? 'plain' : 'muted',
    );
    add(
      floor && ceiling ? 'Award range' : 'Award floor',
      floor && ceiling ? `${floor} – ${ceiling}` : floor,
    );
    const costSharing = sourceValue(row, 'costSharing', 'matchingFundsRaw');
    add(
      'Cost share',
      typeof costSharing === 'boolean' ? (costSharing ? 'Required' : 'Not required') : costSharing,
    );
  } else {
    add(
      'Eligible applicant',
      sourceText(row, 'applicantEligibilityDesc', 'applicantTypeRaw') ??
        (row.applicantTypes.length ? row.applicantTypes.join(', ') : null) ??
        'Not provided by source',
      row.eligibility?.state === 'ineligible' ? 'error' : 'plain',
    );
    add(
      'Place of performance',
      row.geography.join(', ') || 'Not provided by source',
      row.geography.length ? 'plain' : 'muted',
    );
    const ceiling = formatMoney(sourceValue(row, 'ceiling', 'awardCeiling'));
    add(ceiling ? 'Ceiling' : 'Value', ceiling ?? displayValue(row));
    add('Codes', row.naicsCodes.join(', ') || row.pscCodes.join(', '));
  }
  add(
    'Last updated',
    factDate(
      'sourceUpdated',
      sourceText(row, 'sourceUpdatedAt', 'lastUpdatedDate', 'lastUpdatedRaw'),
    ),
  );
  return facts;
}

function typeLabel(row: FundingOpportunityResultRow): string {
  const labels: Record<string, string> = {
    grant: 'Grant',
    cooperative_agreement: 'Cooperative agreement',
    loan_assistance: 'Loan assistance',
    contract: 'Contract',
    solicitation: 'Contract · solicitation',
    task_order_vehicle: 'Contract · task order vehicle',
    presolicitation: 'Contract · pre-solicitation',
    sources_sought: 'Contract · sources sought',
    request_for_quote: 'Contract · request for quote',
    award: 'Award',
    forecast: 'Contract · forecast',
    other: 'Opportunity',
  };
  return labels[row.type] ?? row.type.replaceAll('_', ' ');
}

function lifecycleTag(row: FundingOpportunityResultRow): { label: string; tone: string } {
  if (row.lifecycle === 'forecast') return { label: 'Forecast · early signal', tone: 'warning' };
  if (row.lifecycle === 'closed') return { label: 'Closed', tone: 'error' };
  if (row.lifecycle === 'post_award') return { label: 'Post-award', tone: 'brand' };
  return { label: 'Open', tone: 'success' };
}

function deadlineFor(row: FundingOpportunityResultRow) {
  const forecast = row.source === 'agency_forecast' || row.lifecycle === 'forecast';
  const keys = forecast
    ? ['anticipatedAwardDate', 'estimatedPeriod']
    : [
        'responseDeadline',
        'responseDeadLine',
        'responseDate',
        'responseDateStr',
        'responseDateDesc',
        'applicationDeadlineRaw',
      ];
  const raw = sourceValue(row, ...keys);
  const rawKey = keys.find((key) => sourceValue(row, key) !== null) ?? keys[0]!;
  const fallbackDeadline = forecast && rawKey === 'estimatedPeriod' ? null : row.deadline;
  const dateFact = sourceFact(row, rawKey, fallbackDeadline);
  const rawLabel = sourceValue(
    row,
    'responseDeadLine',
    'responseDateDesc',
    'responseDateStr',
    'applicationDeadlineRaw',
  );
  if (dateFact && typeof rawLabel === 'string' && rawLabel.trim()) {
    dateFact.sourceRaw = rawLabel;
    const rawZone =
      rawLabel.match(
        /(?:T|\s)(?:\d{1,2}:\d{2}(?::\d{2})?\s*)?(Z|[+-]\d{2}:?\d{2}|[A-Z]{2,5})$/,
      )?.[1] ?? null;
    if (rawZone) dateFact.timezone = rawZone;
  }
  return getFundingOpportunityDeadlinePresentation({
    deadline: forecast
      ? (dateFact?.value ??
        sourceText(row, 'anticipatedAwardDate') ??
        sourceText(row, 'estimatedPeriod') ??
        row.deadline)
      : row.deadline,
    lifecycle: row.lifecycle,
    workflowStatus: workflowStatus(row),
    workflowStage: workflowStage(row),
    dateFact,
    source: row.source,
    dateKind: forecast ? 'forecast' : 'response',
  });
}

function canPursue(row: FundingOpportunityResultRow): boolean {
  const stage = workflowStage(row)?.toLowerCase();
  const terminal =
    stage === 'won' || stage === 'lost' || stage === 'passed' || stage === 'dismissed';
  return Boolean(
    row.isPursuable &&
    !terminal &&
    row.lifecycle !== 'closed' &&
    row.lifecycle !== 'forecast' &&
    (row.decoration?.capabilities.pursue.allowed ?? true) &&
    row.clientCapability?.state !== 'ineligible' &&
    row.eligibility?.state !== 'ineligible',
  );
}

function pursueNote(row: FundingOpportunityResultRow): string | null {
  if (canPursue(row)) return null;
  if (row.lifecycle === 'forecast')
    return 'A forecast has no response path, so Pursue is not offered.';
  if (row.lifecycle === 'closed')
    return 'Pursue is hidden on a closed notice. History remains readable.';
  if (row.clientCapability?.reason) return row.clientCapability.reason;
  if (row.eligibility?.state === 'ineligible')
    return 'Pursue is hidden while the client cannot be a lead applicant.';
  return null;
}

export function FundingOpportunityV2ResultCard({
  row,
  clientName,
  matched,
  onOpenDetail,
  onQuick,
  onExternal,
  onClient,
  onAction,
  onNotFit,
  onMenuAction,
}: FundingOpportunityV2ResultCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<OpportunityResultAction | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const deadline = deadlineFor(row);
  const match = matched ? getFundingOpportunityMatchPresentation(row.matchedSignals) : null;
  const statusTags = getFundingOpportunityV2StatusTags({
    mode: matched ? 'matched' : 'all',
    lifecycle: row.lifecycle,
    matchBand: match?.band ?? null,
    eligibilityState: row.clientCapability?.state ?? row.eligibility?.state ?? null,
    workflowStatus: workflowStatus(row),
    workflowStage: workflowStage(row),
    bookmarkSaved: savedState(row),
  });
  const evidence: EvidenceItem[] = row.matchedSignals.map((signal) => ({
    label: fundingOpportunityMatchSignalLabel(signal.signal),
    value: signal.matchedOn,
    tone:
      signal.strength === 'strong' ? 'success' : signal.strength === 'moderate' ? 'brand' : 'muted',
  }));
  const collapsedEvidence = match?.signals
    .filter((signal) => signal.strength !== 'weak')
    .slice(0, 2).length
    ? match.signals.filter((signal) => signal.strength !== 'weak').slice(0, 2)
    : (match?.signals.slice(0, 1) ?? []);
  const lifecycle = lifecycleTag(row);
  const tags = [
    { label: sourceName(row), tone: sourceTone(row) },
    { label: typeLabel(row), tone: 'plain' },
    lifecycle,
    ...statusTags.map((tag) => ({ label: tag.label, tone: tag.tone ?? 'plain' })),
  ];
  const deadlineTone = deadline.tone === 'warning' ? 'warn' : deadline.tone;
  async function handleAction(action: OpportunityResultAction) {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await onAction(action);
    } finally {
      setBusyAction(null);
    }
  }
  return (
    <article className={`fo-v2-result-card fo-v2-result-card--${row.source}`}>
      <span
        className={`fo-v2-result-rule fo-v2-result-rule--${ruleTone(row)}`}
        aria-hidden="true"
      />
      <div className="fo-v2-result-card-body">
        <div className="fo-v2-result-card-main">
        <div className="fo-v2-result-tags">
          {matched && row.clientId && clientName ? (
            <button type="button" className="fo-v2-result-client" onClick={onClient ?? onQuick}>
              <span>{(row.clientInitials ?? clientName.slice(0, 2)).toUpperCase()}</span>
              {clientName}
            </button>
          ) : null}
            {tags.map((tag) => (
              <span
                className={`fo-v2-pill fo-v2-pill--${tag.tone}`}
                key={`${tag.label}:${tag.tone}`}
              >
                {tag.label}
              </span>
            ))}
          </div>
          <h2>
            <button className="fo-v2-result-title" onClick={onOpenDetail}>
              {row.title}
            </button>
          </h2>
          <div className="fo-v2-result-meta">
            <span>
              {row.agency ?? 'Agency not stated'} · {publicReference(row)}
            </span>
            <button type="button" className="fo-v2-result-source" onClick={onExternal}>
              Source <FundingOpportunityV2Icon name="LinkExternal01" size={14} />
            </button>
          </div>
          <p className="fo-v2-result-summary">{row.summary ?? 'Not provided by source'}</p>
          <div className="fo-v2-result-facts">
            {factsFor(row).map((fact) => (
              <div key={`${fact.label}:${fact.value}`}>
                <span>{fact.label}</span>
                <strong
                  className={
                    fact.tone === 'muted'
                      ? 'is-muted'
                      : fact.tone === 'warning'
                        ? 'is-warning'
                        : fact.tone === 'error'
                          ? 'is-error'
                          : ''
                  }
                >
                  {fact.value}
                </strong>
              </div>
            ))}
          </div>
        </div>
        <aside className="fo-v2-result-side">
          <div className={`fo-v2-result-when fo-v2-result-when--${deadlineTone}`}>
            <span>{deadline.label}</span>
            <span className="fo-v2-result-when-date">
              <strong>{deadline.compactValue ?? deadline.value}</strong>
              {deadline.daysRemaining != null &&
              !['closed', 'post_award'].includes(row.lifecycle) ? (
                <b>{deadline.daysRemaining === 0 ? 'today' : `${deadline.daysRemaining}d`}</b>
              ) : null}
            </span>
            {deadline.sourceCalendarYear || deadline.sourceTimeLabel ? (
              <small>
                {[deadline.sourceCalendarYear, deadline.sourceTimeLabel]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            ) : null}
            {!deadline.sourceCalendarYear && !deadline.sourceTimeLabel ? (
              <small>{deadline.note}</small>
            ) : null}
            {pursueNote(row) ? <p className="fo-v2-result-note">{pursueNote(row)}</p> : null}
          </div>
          <div className="fo-v2-result-evidence">
            <div className="fo-v2-result-evidence-heading">
              <span>{matched ? 'MATCH EVIDENCE' : 'RELEVANCE SIGNALS'}</span>
              {matched && match?.label ? (
                <em
                  className={`fo-v2-result-band fo-v2-result-band--${match.band === 'strong' ? 'success' : match.band}`}
                >
                  {match.label}
                </em>
              ) : null}
            </div>
            <strong>
              {matched ? match?.reason : 'Relevance is not calculated in all-opportunities mode.'}
            </strong>
            {matched && collapsedEvidence.length ? (
              <code>{`${collapsedEvidence[0]!.label}: ${collapsedEvidence[0]!.value.split(' — ')[0]}`}</code>
            ) : null}
            {matched ? (
              <button
                className="fo-v2-result-evidence-toggle"
                onClick={() => setEvidenceOpen((open) => !open)}
                aria-expanded={evidenceOpen}
              >
                {evidenceOpen
                  ? 'Hide evidence'
                  : `Evidence (${evidence.length}) · relevance ${row.relevanceScore ?? '—'}`}{' '}
                <FundingOpportunityV2Icon name="ChevronDown" size={14} />
              </button>
            ) : null}
            {matched && evidenceOpen ? (
              <div className="fo-v2-result-evidence-list">
                {evidence.map((item) => (
                  <div key={`${item.label}:${item.value}`}>
                    <em className={`fo-v2-result-band fo-v2-result-band--${item.tone}`}>
                      {item.label}
                    </em>
                    <span>{item.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="fo-v2-result-actions">
            <CapiroButton variant="secondary" className="fo-v2-result-quick" onClick={onQuick}>
              <FundingOpportunityV2Icon name="Expand01" size={16} />
              Quick details
            </CapiroButton>
            <button
              disabled={Boolean(busyAction)}
              className="fo-v2-result-icon-action"
              aria-label={savedState(row) ? 'Remove saved opportunity' : 'Save opportunity'}
              onClick={() => void handleAction('save')}
            >
              <FundingOpportunityV2Icon
                name={savedState(row) ? 'BookmarkCheck' : 'Bookmark'}
                size={16}
              />
            </button>
            {canPursue(row) ? (
              <CapiroButton
                variant="primary"
                className="fo-v2-result-pursue"
                disabled={Boolean(busyAction)}
                onClick={() => void handleAction('pursue')}
              >
                <FundingOpportunityV2Icon name="ZapFast" size={16} />
                {busyAction === 'pursue' ? 'Working…' : 'Pursue'}
              </CapiroButton>
            ) : null}
            <div className="fo-v2-result-menu">
              <button
                ref={menuTriggerRef}
                className="fo-v2-result-icon-action"
                aria-label="More actions"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <FundingOpportunityV2Icon name="DotsHorizontal" size={18} />
              </button>
              {menuOpen ? (
                <div className="fo-v2-result-menu-popover" role="menu" aria-label="Opportunity actions">
                  {(
                    ['follow_up', 'assign_owner', 'note', 'copy_link'] as OpportunityMenuAction[]
                  ).map((action) => (
                    <button
                      key={action}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onMenuAction?.(action, menuTriggerRef.current ?? undefined);
                      }}
                    >
                      {action === 'follow_up'
                        ? 'Set follow-up date'
                        : action === 'assign_owner'
                          ? 'Assign owner'
                          : action === 'copy_link'
                            ? 'Copy shareable link'
                            : 'Add note'}
                    </button>
                  ))}
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onExternal();
                    }}
                  >
                    Open authoritative source
                  </button>
                  {onNotFit ? (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onNotFit(menuTriggerRef.current ?? undefined);
                      }}
                    >
                      Dismiss — not a fit
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </article>
  );
}
