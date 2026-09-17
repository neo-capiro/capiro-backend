import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FundingOpportunityV2QuickPanel } from './FundingOpportunityV2QuickPanel.js';
import { FundingOpportunityV2ExternalConfirmation } from './FundingOpportunityV2ExternalConfirmation.js';
import {
  FundingOpportunityV2Icon,
  type FundingOpportunityV2IconName,
} from './funding-opportunities-v2-icons.js';
import {
  buildFundingOpportunityV2DetailModel,
  FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION,
  type FundingOpportunityV2Action,
  type FundingOpportunityV2DetailInput,
  type FundingOpportunityV2DetailModel,
  type FundingOpportunityV2ExternalAudit,
  type FundingOpportunityV2Section,
} from './funding-opportunities-v2-detail-types.js';
import './funding-opportunities-v2-detail.css';

export interface FundingOpportunityV2DetailProps {
  input?: FundingOpportunityV2DetailInput;
  model?: FundingOpportunityV2DetailModel;
  onBack: () => void;
  onAction: FundingOpportunityV2Action;
  onSaveSearch?: () => void;
  onExternalAudit: FundingOpportunityV2ExternalAudit;
  onOpenSimilar: (row: FundingOpportunityV2DetailModel['similar'][number]) => void;
  onOpenQuick: () => void;
}

function Icon({ name, size = 18 }: { name: FundingOpportunityV2IconName; size?: number }) {
  return <FundingOpportunityV2Icon name={name} size={size} />;
}
function Fact({
  label,
  value,
  mono,
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
function Bullet({
  label,
  text,
  badge,
  quote,
  tone = 'plain',
}: {
  label?: string;
  text: string;
  badge?: string;
  quote?: string;
  tone?: string;
}) {
  return (
    <li>
      <span className={`fo-v2-detail-bullet-dot fo-v2-detail-bullet-dot--${tone}`} />
      <div className="fo-v2-detail-bullet-content">
        {label || badge ? (
          <div className="fo-v2-detail-bullet-label">
            {label ? <strong>{label}</strong> : null}
            {badge ? (
              <span className={`fo-v2-detail-pill fo-v2-detail-pill--${tone}`}>{badge}</span>
            ) : null}
          </div>
        ) : null}
        <span>{text}</span>
        {quote ? <blockquote className="fo-v2-detail-quote">{quote}</blockquote> : null}
      </div>
    </li>
  );
}
function dateTextForSimilar(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}
function DeadlineValue({
  value,
  compactValue,
  sourceCalendarYear,
  sourceTimeLabel,
  daysRemaining,
}: {
  value: string;
  compactValue?: string;
  sourceCalendarYear?: number | null;
  sourceTimeLabel?: string | null;
  daysRemaining: number | null;
}) {
  return (
    <>
      <span className="fo-v2-detail-deadline-value">
        <strong>{compactValue ?? value}</strong>
        {daysRemaining != null ? (
          <span className="fo-v2-detail-day-chip">{daysRemaining}d</span>
        ) : null}
      </span>
      {sourceCalendarYear != null ? (
        <small className="fo-v2-detail-deadline-note">
          {sourceCalendarYear}
          {sourceTimeLabel ? ` · ${sourceTimeLabel}` : ''}
        </small>
      ) : sourceTimeLabel ? (
        <small className="fo-v2-detail-deadline-note">{sourceTimeLabel}</small>
      ) : null}
    </>
  );
}
function Section({
  section,
  resetKey,
}: {
  section: FundingOpportunityV2Section;
  resetKey: string;
}) {
  const [open, setOpen] = useState(section.initiallyOpen ?? false);
  useEffect(() => setOpen(section.initiallyOpen ?? false), [resetKey, section.initiallyOpen]);
  return (
    <section className="fo-v2-detail-section">
      <button
        className={`fo-v2-detail-section__header ${section.tone === 'muted' ? 'is-muted' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{section.title}</span>
        {section.badge ? (
          <span className={`fo-v2-detail-pill fo-v2-detail-pill--${section.badgeTone ?? 'muted'}`}>
            {section.badge}
          </span>
        ) : null}
        <span className="fo-v2-detail-section__chevron" data-open={open}>
          <Icon name="ChevronDown" size={16} />
        </span>
      </button>
      {open ? (
        <div className="fo-v2-detail-section__body">
          {section.lead ? <p className="fo-v2-detail-lead">{section.lead}</p> : null}
          {section.facts?.length ? (
            <div className="fo-v2-detail-facts">
              {section.facts.map((fact) => (
                <Fact
                  key={fact.label}
                  label={fact.label}
                  value={fact.value}
                  mono={fact.mono}
                  tone={fact.tone}
                />
              ))}
            </div>
          ) : null}
          {section.chips?.length ? (
            <div className="fo-v2-detail-tags">
              {section.chips.map((chip) => (
                <span className="fo-v2-detail-pill fo-v2-detail-pill--muted" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
          {section.bullets?.length ? (
            <ul className="fo-v2-detail-bullets">
              {section.bullets.map((bullet, index) => (
                <Bullet key={`${bullet.label ?? ''}:${bullet.text}:${index}`} {...bullet} />
              ))}
            </ul>
          ) : null}
          {section.footnote ? <p className="fo-v2-detail-footnote">{section.footnote}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function FundingOpportunityV2Detail({
  input,
  model: suppliedModel,
  onBack,
  onAction,
  onSaveSearch,
  onExternalAudit,
  onOpenSimilar,
}: FundingOpportunityV2DetailProps) {
  const model = suppliedModel ?? (input ? buildFundingOpportunityV2DetailModel(input) : null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedDestination, setSelectedDestination] = useState<typeof destination>(null);
  const sourceTriggerRef = useRef<HTMLElement | null>(null);
  if (!model)
    return (
      <div className="fo-v2-detail-error" role="alert">
        This opportunity detail is unavailable.
      </div>
    );
  const destination = model.actions.source;
  const openDestination = (element: HTMLElement, next: NonNullable<typeof destination>) => {
    sourceTriggerRef.current = element;
    setSelectedDestination(next);
    setSourceOpen(true);
  };
  const openSource = (element: HTMLElement) => {
    if (destination) openDestination(element, destination);
  };
  const sourceCount = model.raw.changeNotes?.length ?? 0;
  const sourceFacts = model.provenance.filter((fact) => fact.label !== 'Source model');
  return (
    <main className="fo-v2-detail" data-testid="funding-opportunity-v2-detail">
      <div className="fo-v2-detail__back-row">
        <button className="fo-v2-detail-back" onClick={onBack}>
          <Icon name="ChevronLeft" size={16} />
          Back to results
        </button>
        <span>Client context, criteria and scroll position are preserved.</span>
        <span className="fo-v2-detail-scope">{model.scopeChip}</span>
      </div>
      <header className="fo-v2-detail__header">
        <div className="fo-v2-detail-tags">
          {model.tags.map((tag) => (
            <span
              key={tag.label}
              className={`fo-v2-detail-pill fo-v2-detail-pill--${tag.tone ?? 'plain'} ${tag === model.tags[0] ? `fo-v2-detail-pill--source-${FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[model.source].tone}` : ''}`}
            >
              {tag.label}
            </span>
          ))}
        </div>
        <h1>{model.title}</h1>
        <p>{model.meta}</p>
        <div className="fo-v2-detail-stamp">
          <span>{model.stamp}</span>
          <button
            onClick={(event) => {
              const source = document.getElementById('fo-v2-detail-section-source');
              if (source) {
                source.scrollIntoView({ behavior: 'smooth', block: 'start' });
                const header = source.querySelector('button');
                if (header?.getAttribute('aria-expanded') !== 'true') header?.click();
              }
            }}
          >
            {' '}
            {sourceCount} change notes
          </button>
        </div>
        <div className="fo-v2-detail-actions">
          <button
            className="fo-v2-detail-button fo-v2-detail-button--dark"
            onClick={(event) => openSource(event.currentTarget)}
            disabled={!destination?.url}
          >
            <Icon name="LinkExternal01" size={18} />
            {destination?.kind === 'source_page'
              ? model.source === 'sam_gov'
                ? 'View solicitation on SAM.gov'
                : `View on ${model.source}`
              : (destination?.label ?? destination?.kind ?? 'Source unavailable')}
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
          {model.actions.canPursue ? (
            <button
              className="fo-v2-detail-button"
              onClick={() =>
                void onAction({
                  action: 'pursue',
                  source: model.source,
                  sourceRecordId: model.sourceRecordId,
                  clientId: model.raw.clientId,
                })
              }
            >
              <Icon name="ZapFast" size={18} />
              Mark pursuing
            </button>
          ) : (
            <span className="fo-v2-detail-action-note">{model.actions.pursueNote}</span>
          )}
          <button
            className="fo-v2-detail-button fo-v2-detail-button--not-fit"
            onClick={() =>
              void onAction({
                action: 'not_fit',
                source: model.source,
                sourceRecordId: model.sourceRecordId,
                clientId: model.raw.clientId,
              })
            }
          >
            <Icon name="SlashCircle01" size={18} />
            Not a fit
          </button>
          <span className="fo-v2-detail-actions-spacer" aria-hidden="true" />
          <p className="fo-v2-detail-reassurance">
            Workflow actions are per client and per opportunity, and each one is audited.
          </p>
        </div>
      </header>
      <div className="fo-v2-detail__body">
        <div className="fo-v2-detail__main">
          {model.sections.map((section) => (
            <div id={`fo-v2-detail-section-${section.id}`} key={section.id}>
              <Section section={section} resetKey={model.sourceRecordId} />
            </div>
          ))}
        </div>
        <aside className="fo-v2-detail__rail">
          <section className="fo-v2-detail-rail-card fo-v2-detail-response-card">
            <h2>Response path</h2>
            <div className="fo-v2-detail-rail-card__body">
              {model.deadline ? (
                <div
                  className={`fo-v2-detail-deadline fo-v2-detail-deadline--${model.deadline.tone}`}
                >
                  <span>{model.deadline.label}</span>
                  <DeadlineValue
                    value={model.deadline.value}
                    compactValue={model.deadline.compactValue}
                    sourceCalendarYear={model.deadline.sourceCalendarYear}
                    sourceTimeLabel={model.deadline.sourceTimeLabel}
                    daysRemaining={model.deadline.daysRemaining}
                  />
                  {model.deadline.daysRemaining == null ? (
                    <small>{model.deadline.note}</small>
                  ) : null}
                </div>
              ) : null}
              {model.responsePath.length
                ? (() => {
                    const responseDestination =
                      model.destinations.find((item) => item.kind.startsWith('application:')) ??
                      model.destinations.find((item) => item.kind === 'source_page');
                    return responseDestination?.url ? (
                      <button
                        className="fo-v2-detail-button fo-v2-detail-button--dark fo-v2-detail-rail-primary"
                        onClick={(event) =>
                          openDestination(event.currentTarget, responseDestination)
                        }
                      >
                        <Icon name="LinkExternal01" size={16} />
                        {responseDestination.label}
                      </button>
                    ) : null;
                  })()
                : null}
              {model.responsePath.length ? (
                <p className="fo-v2-detail-response-guidance">{model.responsePath[0]!.value}</p>
              ) : (
                <p>Not provided by source</p>
              )}
              {model.contacts.length ? (
                <div className="fo-v2-detail-contact-list">
                  <span className="fo-v2-detail-eyebrow">Contact</span>
                  {model.contacts.map((contact) => (
                    <div className="fo-v2-detail-contact" key={contact.key}>
                      <strong>{contact.name ?? 'Not provided by source'}</strong>
                      <span>{contact.description ?? 'Source contact'}</span>
                      <span>{contact.phone ?? 'Phone not provided'}</span>
                      {contact.email ? (
                        <button
                          className="fo-v2-detail-link-button"
                          onClick={(event) => {
                            const target = model.destinations.find(
                              (item) => item.kind === `contact_email:${contact.key}`,
                            );
                            if (target) openDestination(event.currentTarget, target);
                          }}
                        >
                          {contact.email}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
          <section className="fo-v2-detail-rail-card">
            <h2>Provenance</h2>
            <div className="fo-v2-detail-provenance">
              {sourceFacts.map((fact) => (
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
          {model.similar.length ? (
            <section className="fo-v2-detail-rail-card">
              <h2>Similar opportunities</h2>
              <div className="fo-v2-detail-similar">
                {model.similar.map((row) => (
                  <button
                    key={`${row.source}:${row.sourceRecordId}`}
                    onClick={() => onOpenSimilar(row)}
                  >
                    <strong>{row.title}</strong>
                    <span className="fo-v2-detail-similar-meta">
                      <em
                        className={`fo-v2-detail-similar-type fo-v2-detail-similar-type--${row.type ?? 'unknown'}`}
                      >
                        {row.type === 'solicitation' || row.type === 'contract'
                          ? 'Contract'
                          : row.type === 'grant' ||
                              row.type === 'cooperative_agreement' ||
                              row.type === 'loan_assistance'
                            ? 'Grant'
                            : row.type === 'forecast'
                              ? 'Forecast'
                              : 'Type unavailable'}
                      </em>
                      <span>
                        {row.deadline
                          ? `Closes ${dateTextForSimilar(row.deadline)}`
                          : 'Deadline not provided by source'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="fo-v2-detail-similar-footer">
                <button className="fo-v2-detail-button" onClick={() => onSaveSearch?.()}>
                  Save as search
                </button>
                <span>
                  Similarity uses source-backed codes, agency, geography and scope evidence.
                </span>
              </div>
            </section>
          ) : null}
        </aside>
      </div>
      {sourceOpen && selectedDestination?.url ? (
        <FundingOpportunityV2ExternalConfirmation
          destination={selectedDestination}
          source={model.source}
          sourceRecordId={model.sourceRecordId}
          clientId={model.raw.clientId}
          returnFocusRef={sourceTriggerRef}
          onExternalAudit={onExternalAudit}
          onClose={() => setSourceOpen(false)}
        />
      ) : null}
    </main>
  );
}

export { FundingOpportunityV2QuickPanel };
export type { FundingOpportunityV2DetailModel };
