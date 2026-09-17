import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OpportunitySearchMode, OpportunitySourceV2 } from '@capiro/shared';
import {
  FundingOpportunityV2Icon,
  type FundingOpportunityV2IconName,
} from './funding-opportunities-v2-icons.js';
import {
  buildFundingOpportunityV2DetailModel,
  normalizeFundingOpportunityV2Detail,
  FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION,
  type FundingOpportunityV2Action,
  type FundingOpportunityV2DetailModel,
  type FundingOpportunityV2ExternalAudit,
} from './funding-opportunities-v2-detail-types.js';
import type { FundingOpportunityV2Api } from './FundingOpportunitiesV2Adapter.js';
import { opportunityQueryKeys } from './opportunity-query-cache.js';
import { FundingOpportunityV2ExternalConfirmation } from './FundingOpportunityV2ExternalConfirmation.js';
import './funding-opportunities-v2-detail.css';

export interface FundingOpportunityV2QuickPanelProps {
  model: FundingOpportunityV2DetailModel;
  onClose: () => void;
  onOpenFullDetail: () => void;
  onAction: FundingOpportunityV2Action;
  onExternalAudit: FundingOpportunityV2ExternalAudit;
}

export interface FundingOpportunityV2QuickDetailsQueryProps {
  api: FundingOpportunityV2Api;
  source: OpportunitySourceV2;
  sourceRecordId: string;
  clientId: string | null;
  mode: OpportunitySearchMode;
  clientName?: string | null;
  enabled?: boolean;
  children: (state: {
    model: FundingOpportunityV2DetailModel | null;
    isLoading: boolean;
    isError: boolean;
    retry: () => void;
  }) => ReactNode;
}

/** Fetches rich detail only while Quick is open and shares the full-detail cache. */
export function FundingOpportunityV2QuickDetailsQuery({
  api,
  source,
  sourceRecordId,
  clientId,
  mode,
  clientName,
  enabled = true,
  children,
}: FundingOpportunityV2QuickDetailsQueryProps) {
  const query = useQuery({
    queryKey: opportunityQueryKeys.detail(source, sourceRecordId, clientId, mode),
    queryFn: ({ signal }) => api.getDetail(source, sourceRecordId, clientId, mode, signal),
    enabled,
    retry: false,
  });
  const model = query.data
    ? buildFundingOpportunityV2DetailModel(
        normalizeFundingOpportunityV2Detail(query.data.opportunity, { mode, clientName }),
      )
    : null;
  return (
    <>
      {children({
        model,
        isLoading: query.isPending,
        isError: query.isError,
        retry: () => void query.refetch(),
      })}
    </>
  );
}

function Icon({ name, size = 18 }: { name: FundingOpportunityV2IconName; size?: number }) {
  return <FundingOpportunityV2Icon name={name} size={size} />;
}

function Fact({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="fo-v2-detail-fact">
      <span>{label}</span>
      <strong className={`${mono ? 'is-mono ' : ''}${tone ? `is-${tone}` : ''}`}>{value}</strong>
    </div>
  );
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ];
}

function QuickDeadline({
  deadline,
}: {
  deadline: NonNullable<FundingOpportunityV2DetailModel['deadline']>;
}) {
  return (
    <div className={`fo-v2-detail-deadline fo-v2-detail-deadline--${deadline.tone}`}>
      <span>{deadline.label}</span>
      <span className="fo-v2-detail-deadline-value">
        <strong>{deadline.compactValue ?? deadline.value}</strong>
        {deadline.daysRemaining != null ? (
          <span className="fo-v2-detail-day-chip">{deadline.daysRemaining}d</span>
        ) : null}
        {deadline.sourceCalendarYear != null || deadline.sourceTimeLabel ? (
          <small className="fo-v2-detail-deadline-note">
            {deadline.sourceCalendarYear ?? ''}
            {deadline.sourceCalendarYear != null && deadline.sourceTimeLabel ? ' · ' : ''}
            {deadline.sourceTimeLabel ?? ''}
          </small>
        ) : deadline.daysRemaining == null ? (
          <small className="fo-v2-detail-deadline-note">{deadline.note}</small>
        ) : null}
      </span>
    </div>
  );
}

export function FundingOpportunityV2QuickPanel({
  model,
  onClose,
  onOpenFullDetail,
  onAction,
  onExternalAudit,
}: FundingOpportunityV2QuickPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const sourceTriggerRef = useRef<HTMLElement | null>(null);
  const sourceOpenRef = useRef(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  sourceOpenRef.current = sourceOpen;
  const destination = model.actions.source;
  const eligibility = model.sections.find((section) => section.id === 'eligibility')?.facts ?? [];
  const geography = model.sections.find((section) => section.id === 'geography')?.facts ?? [];
  const economics = model.sections.find((section) => section.id === 'economics')?.facts ?? [];
  const lastUpdated =
    model.sections
      .find((section) => section.id === 'dates')
      ?.facts?.find((fact) => fact.label === 'Last updated') ?? null;
  const decisionFacts = [
    ...eligibility,
    ...geography,
    ...economics,
    ...(lastUpdated ? [lastUpdated] : []),
  ];
  const matchSection = model.sections.find((section) => section.id === 'match');
  const matchNote = model.match
    ? `Relevance ${model.match.score ?? 'not calculated'} of 100 · ${model.raw.type ?? 'source record'}.`
    : null;

  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    root.focus();
    const mountFocus = window.setTimeout(() => root.focus(), 0);
    return () => window.clearTimeout(mountFocus);
  }, []);

  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (sourceOpenRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable(root);
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => () => restoreFocusRef.current?.focus(), []);

  const openSource = (element: HTMLElement) => {
    sourceTriggerRef.current = element;
    setSourceOpen(true);
  };

  return (
    <div className="fo-v2-detail-panel--quick-overlay" data-fo-v2-overlay="quick">
      <button
        className="fo-v2-detail-panel--quick-backdrop"
        aria-label="Close quick details"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="fo-v2-detail-panel fo-v2-detail-panel--quick"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fo-v2-quick-title"
        tabIndex={-1}
      >
        <header className="fo-v2-detail-panel__header">
          <div>
            <div className="fo-v2-detail-tags">
              {model.tags.map((tag, index) => (
                <span
                  key={tag.label}
                  className={`fo-v2-detail-pill fo-v2-detail-pill--${index === 0 ? `source-${FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[model.source].tone}` : (tag.tone ?? 'plain')}`}
                >
                  {tag.label}
                </span>
              ))}
            </div>
            <h2 id="fo-v2-quick-title">{model.title}</h2>
            <p>{model.meta}</p>
          </div>
          <button
            className="fo-v2-detail-icon-button"
            aria-label="Close quick details"
            onClick={onClose}
          >
            <Icon name="XClose" size={20} />
          </button>
          <div className="fo-v2-detail-panel__actions">
            <button
              className="fo-v2-detail-button fo-v2-detail-button--dark"
              onClick={onOpenFullDetail}
            >
              View full details
            </button>
            <button
              className="fo-v2-detail-button"
              onClick={() =>
                void onAction({
                  action: 'save',
                  source: model.source,
                  sourceRecordId: model.sourceRecordId,
                  clientId: model.raw.clientId,
                })
              }
            >
              <Icon name="Bookmark" size={18} />
              Save
            </button>
            <span className="fo-v2-detail-actions-spacer" aria-hidden="true" />
            {destination ? (
              <button
                className="fo-v2-detail-link-button"
                onClick={(event) => openSource(event.currentTarget)}
              >
                Open source <Icon name="LinkExternal01" size={16} />
              </button>
            ) : null}
          </div>
          <p className="fo-v2-detail-panel__reassurance">
            Escape closes this panel and returns focus to the row. Your list position is unchanged.
          </p>
        </header>
        <div className="fo-v2-detail-panel__body">
          {model.deadline ? <QuickDeadline deadline={model.deadline} /> : null}
          {decisionFacts.length ? (
            <section className="fo-v2-detail-quick-card">
              <h3>Decision-relevant fields</h3>
              <div className="fo-v2-detail-facts">
                {decisionFacts.map((fact) => (
                  <Fact
                    key={fact.label}
                    label={fact.label}
                    value={fact.value}
                    mono={fact.mono}
                    tone={fact.tone}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {model.match ? (
            <section className="fo-v2-detail-quick-card">
              <div className="fo-v2-detail-quick-card__heading">
                <h3>Why this matched</h3>
                <span
                  className={`fo-v2-detail-pill fo-v2-detail-pill--${matchSection?.badgeTone ?? 'brand'}`}
                >
                  {matchSection?.badge ?? 'Evidence returned'}
                </span>
              </div>
              <div className="fo-v2-detail-quick-card__body">
                <p>{model.match.reason}</p>
                <div className="fo-v2-detail-evidence">
                  {model.match.signals.map((signal) => (
                    <div key={`${signal.label}:${signal.value}`}>
                      <span
                        className={`fo-v2-detail-pill fo-v2-detail-pill--${signal.strength === 'strong' ? 'success' : signal.strength === 'moderate' ? 'brand' : 'muted'}`}
                      >
                        {signal.label}
                      </span>
                      <code>{signal.value}</code>
                    </div>
                  ))}
                </div>
                <p className="fo-v2-detail-footnote">{matchNote}</p>
              </div>
            </section>
          ) : null}
        </div>
        {sourceOpen && destination?.url ? (
          <FundingOpportunityV2ExternalConfirmation
            destination={destination}
            source={model.source}
            sourceRecordId={model.sourceRecordId}
            clientId={model.raw.clientId}
            returnFocusRef={sourceTriggerRef}
            onExternalAudit={onExternalAudit}
            onClose={() => setSourceOpen(false)}
          />
        ) : null}
      </aside>
    </div>
  );
}

export { focusable as fundingOpportunityV2FocusableElements };
