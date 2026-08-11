import { useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  useDashboardVNextModel,
  type AttentionItem,
  type DashboardModuleState,
  type DashboardVNextModel,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import { useShellOverlay } from '../../shell/overlay-manager.js';
import './dashboard.css';

/**
 * Dashboard vNext (Figma `751:2502` expanded, `753:2532` collapsed,
 * `754:2562` customize, `754:2885` system states).
 *
 * Always all-client: the controller reads no client context, and the shell
 * disables the client control on this route.
 */
export function DashboardVNext() {
  const model = useDashboardVNextModel();
  return <DashboardVNextView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function DashboardVNextView({ model }: { model: DashboardVNextModel }) {
  return (
    <div className="capiro-dash" data-density={model.density}>
      <DashboardHeader model={model} />

      <div className="capiro-dash__content">
        {/* Needs Attention is permanently pinned first and is not hideable. */}
        <NeedsAttention module={model.needsAttention} />

        <div className="capiro-dash__columns">
          {model.visibility.news ? <NewsAndNarrative model={model} /> : null}

          <div className="capiro-dash__stack">
            {model.visibility.today ? <TodayAndComingUp module={model.today} /> : null}
            {model.visibility.work ? <WorkQueue module={model.workQueue} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardHeader({ model }: { model: DashboardVNextModel }) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay('dashboard-customize');
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <header className="capiro-dash__header">
      <p className="capiro-dash__eyebrow">{model.header.eyebrow}</p>
      <h1 className="capiro-dash__greeting">{model.header.greeting}</h1>
      <p className="capiro-dash__meta">{model.header.meta}</p>

      <div className="capiro-dash__header-actions" ref={containerRef}>
        <button
          ref={triggerRef}
          type="button"
          className="capiro-dash__customize capiro-elevation-control"
          aria-expanded={isOpen}
          aria-haspopup="menu"
          onClick={() => toggle(triggerRef.current)}
        >
          Customize
        </button>
        {model.header.refreshedLabel ? (
          <span className="capiro-dash__refreshed">{model.header.refreshedLabel}</span>
        ) : null}

        {isOpen ? (
          <div
            className="capiro-dash__customize-panel capiro-elevation-popover"
            role="menu"
            aria-label="Customize dashboard"
          >
            <p className="capiro-dash__customize-eyebrow">MODULES</p>
            <p className="capiro-dash__customize-note">
              Needs Attention is always shown.
            </p>

            {(
              [
                ['news', 'News & Narrative'],
                ['today', 'Today & Coming Up'],
                ['work', 'Work Queue'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="capiro-dash__customize-row">
                <input
                  type="checkbox"
                  checked={model.visibility[key]}
                  onChange={(event) =>
                    model.setVisibility({ ...model.visibility, [key]: event.target.checked })
                  }
                />
                <span>{label}</span>
              </label>
            ))}

            <p className="capiro-dash__customize-eyebrow">PRESENTATION</p>
            <div className="capiro-dash__density">
              {(['standard', 'compact'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="capiro-dash__density-option"
                  aria-pressed={model.density === value}
                  onClick={() => model.setDensity(value)}
                >
                  {value === 'standard' ? 'Standard' : 'Compact'}
                </button>
              ))}
            </div>

            <button type="button" className="capiro-dash__customize-done" onClick={close}>
              Done
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/* ── Needs Attention ─────────────────────────────────────────────────────── */

function NeedsAttention({ module }: { module: DashboardVNextModel['needsAttention'] }) {
  return (
    <section className="capiro-dash-card capiro-dash-card--attention" aria-label="Needs attention">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Needs Attention</h2>
        <span className="capiro-dash-card__count">
          {module.state === 'loading'
            ? 'Loading…'
            : module.total > 0
              ? `${module.total} TIME-SENSITIVE ITEM${module.total === 1 ? '' : 'S'}`
              : ''}
        </span>
        {module.total > 0 ? (
          <Link className="capiro-dash-card__link" to="/explorer">
            View all →
          </Link>
        ) : null}
      </div>

      <ModuleState state={module.state} module="Needs Attention" />

      {module.state === 'partial' ? (
        <p className="capiro-dash__partial">
          Some intelligence sources did not respond. This list may be incomplete.
        </p>
      ) : null}

      {module.items.map((item, index) => (
        <AttentionRow key={item.id} item={item} current={index === 0} />
      ))}
    </section>
  );
}

/**
 * Status/Badge tone axis (Figma `271:6/12/15/18`). Tone is severity; the badge
 * label is the kind of work. The two axes stay independent.
 */
function badgeTone(item: AttentionItem): 'danger' | 'warning' | 'review' | 'information' {
  if (item.severity === 'critical') return 'danger';
  if (item.severity === 'high') return 'warning';
  if (item.kind === 'BUDGET') return 'review';
  return 'information';
}

function AttentionRow({ item, current }: { item: AttentionItem; current: boolean }) {
  const body = (
    <>
      <span className="capiro-dash-attention__badge" data-tone={badgeTone(item)}>
        {item.kind}
      </span>
      <span className="capiro-dash-attention__copy">
        <span className="capiro-dash-attention__eyebrow">{item.eyebrow}</span>
        <span className="capiro-dash-attention__title">{item.title}</span>
      </span>
      <span className="capiro-dash-attention__context">{item.context}</span>
      <span className="capiro-dash-attention__due">{item.due}</span>
      <span className="capiro-dash-attention__action">{item.actionLabel}</span>
    </>
  );

  // Exactly one primary action per decision region, per the Button/Main guidance
  // in Figma: the lead row is "current" and owns it.
  return item.href ? (
    <Link
      className="capiro-dash-attention"
      data-severity={item.severity}
      data-current={current || undefined}
      to={item.href}
    >
      {body}
    </Link>
  ) : (
    <div
      className="capiro-dash-attention"
      data-severity={item.severity}
      data-current={current || undefined}
    >
      {body}
    </div>
  );
}

/* ── News & Narrative ────────────────────────────────────────────────────── */

function NewsAndNarrative({ model }: { model: DashboardVNextModel }) {
  const module = model.news;

  return (
    <section className="capiro-dash-card capiro-dash-card--news" aria-label="News and narrative">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">News &amp; Narrative</h2>
        <span className="capiro-dash-card__count">{module.meta}</span>
        <Link className="capiro-dash-card__link" to="/explorer">
          Customize feed
        </Link>
      </div>

      {module.state === 'stale' ? (
        <p className="capiro-dash__partial">Showing cached results while the feed refreshes.</p>
      ) : null}

      {module.state === 'unavailable' ? (
        <div className="capiro-dash__state">
          <p className="capiro-dash__state-title">News is unavailable</p>
          <p className="capiro-dash__state-body">{module.unavailableReason}</p>
        </div>
      ) : (
        <ModuleState state={module.state} module="News" />
      )}

      {module.items.map((item) => (
        <a
          key={item.id}
          className="capiro-dash-news"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span className="capiro-dash-news__thumb" aria-hidden="true">
            {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : null}
          </span>
          <span className="capiro-dash-news__copy">
            <span className="capiro-dash-news__source">{item.source}</span>
            <span className="capiro-dash-news__title">{item.title}</span>
            <span className="capiro-dash-news__reason">{item.reason}</span>
          </span>
          <span className="capiro-dash-news__client">{item.clients}</span>
        </a>
      ))}
    </section>
  );
}

/* ── Today & Coming Up ───────────────────────────────────────────────────── */

function TodayAndComingUp({ module }: { module: DashboardVNextModel['today'] }) {
  return (
    <section className="capiro-dash-card" aria-label="Today and coming up">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Today &amp; Coming Up</h2>
        <Link className="capiro-dash-card__link" to="/engagement">
          Open Engagement
        </Link>
      </div>

      {module.week.length > 0 ? (
        <div className="capiro-dash-week">
          {module.week.map((day) => (
            <div
              key={day.id}
              className="capiro-dash-week__day"
              data-today={day.today || undefined}
            >
              <span className="capiro-dash-week__weekday">{day.weekday}</span>
              <span className="capiro-dash-week__number">{day.day}</span>
              {day.hasEvents ? <span className="capiro-dash-week__dot" aria-hidden="true" /> : null}
            </div>
          ))}
        </div>
      ) : null}

      <ModuleState state={module.state} module="Today" />

      {module.events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </section>
  );
}

function EventRow({ event }: { event: DashboardVNextModel['today']['events'][number] }) {
  const label =
    event.action === 'join'
      ? 'Join'
      : event.action === 'prepare'
        ? 'Prepare'
        : event.action === 'brief'
          ? 'Brief'
          : 'Open';

  const body = (
    <>
      <span className="capiro-dash-event__time">{event.time}</span>
      <span className="capiro-dash-event__copy">
        <span className="capiro-dash-event__title">{event.title}</span>
        <span className="capiro-dash-event__meta">{event.meta}</span>
      </span>
      <span className="capiro-dash-event__action">{label}</span>
    </>
  );

  if (event.action === 'join' && event.joinUrl) {
    return (
      <a className="capiro-dash-event" href={event.joinUrl} target="_blank" rel="noreferrer noopener">
        {body}
      </a>
    );
  }

  return event.href ? (
    <Link className="capiro-dash-event" to={event.href}>
      {body}
    </Link>
  ) : (
    <div className="capiro-dash-event">{body}</div>
  );
}

/* ── Work Queue ──────────────────────────────────────────────────────────── */

function WorkQueue({ module }: { module: DashboardVNextModel['workQueue'] }) {
  return (
    <section className="capiro-dash-card" aria-label="Work queue">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Work Queue</h2>
        <span className="capiro-dash-card__count">{module.total > 0 ? module.total : ''}</span>
        <Link className="capiro-dash-card__link" to="/workspace">
          View all
        </Link>
      </div>

      <ModuleState state={module.state} module="Work Queue" />

      {module.items.map((item) => (
        <Link key={item.id} className="capiro-dash-work" to={item.href}>
          <span className="capiro-dash-work__kind">{item.kind}</span>
          <span className="capiro-dash-work__title">{item.title}</span>
          <span className="capiro-dash-work__status">{item.status}</span>
        </Link>
      ))}
    </section>
  );
}

/* ── Shared system states (Figma 754:2885) ──────────────────────────────── */

function ModuleState({ state, module }: { state: DashboardModuleState; module: string }) {
  if (state === 'loading') {
    return (
      <div className="capiro-dash__skeletons" aria-busy="true" aria-label={`${module} loading`}>
        <span className="capiro-dash__skeleton" />
        <span className="capiro-dash__skeleton" />
        <span className="capiro-dash__skeleton" />
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="capiro-dash__state">
        <p className="capiro-dash__state-title">{module} is unavailable</p>
        <p className="capiro-dash__state-body">
          The request failed, so no count is shown. Retry shortly.
        </p>
      </div>
    );
  }

  if (state === 'all-clear') {
    return (
      <div className="capiro-dash__state">
        <p className="capiro-dash__state-title">All clear</p>
        <p className="capiro-dash__state-body">Nothing needs attention right now.</p>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div className="capiro-dash__state">
        <p className="capiro-dash__state-title">Nothing here yet</p>
      </div>
    );
  }

  return null;
}
