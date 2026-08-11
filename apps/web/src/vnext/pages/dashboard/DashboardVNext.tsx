import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  useDashboardVNextModel,
  type AttentionItem,
  type DashboardModuleKey,
  type DashboardVNextModel,
  type ModuleStatus,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import { CustomizeDrawer } from './CustomizeDrawer.js';
import './dashboard.css';

/**
 * Dashboard vNext (Figma `751:2502` desktop, `757:2618` tablet, `757:2622`
 * mobile, `754:2766` customize drawer, `754:2885` system states).
 *
 * Ship gate `760:2736`: all-client scope, Needs Attention free of internal
 * work, Work Queue limited to outreach and work documents, explained news,
 * explicit states, and parity across expanded/collapsed/customize/tablet/mobile.
 */
export function DashboardVNext() {
  const model = useDashboardVNextModel();
  return <DashboardVNextView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function DashboardVNextView({ model }: { model: DashboardVNextModel }) {
  const modules: Record<DashboardModuleKey, ReactNode> = {
    news: model.visibility.news ? <NewsAndNarrative key="news" model={model} /> : null,
    today: model.visibility.today ? <TodayAndComingUp key="today" model={model} /> : null,
    work: model.visibility.work ? <WorkQueue key="work" model={model} /> : null,
  };

  // Mobile is a different content model, not a narrower desktop (`757:2622`):
  // a single Next Meeting card stands in for Today & Coming Up, and the Work
  // Queue collapses to its lead item.
  if (model.isMobile) {
    return (
      <div className="capiro-dash" data-density={model.density} data-viewport="mobile">
        <DashboardHeader model={model} />
        <div className="capiro-dash__content">
          <NeedsAttention model={model} />
          {model.order.map((key) =>
            key === 'today'
              ? model.visibility.today && <NextMeetingCard key="today" model={model} />
              : key === 'work'
                ? model.visibility.work && <MobileWorkQueue key="work" model={model} />
                : modules[key],
          )}
        </div>
      </div>
    );
  }

  // Desktop/tablet keep the designed two-column body: News leads the wide
  // column and the remaining modules stack on the right, in user order.
  const ordered = model.order.filter((key) => modules[key] !== null);
  const lead = ordered.find((key) => key === 'news') ?? ordered[0];
  const rest = ordered.filter((key) => key !== lead);

  return (
    <div className="capiro-dash" data-density={model.density}>
      <DashboardHeader model={model} />

      <div className="capiro-dash__content">
        {/* Needs Attention is permanently pinned first and is not hideable. */}
        <NeedsAttention model={model} />

        <div className="capiro-dash__columns">
          {lead ? modules[lead] : null}
          <div className="capiro-dash__stack">{rest.map((key) => modules[key])}</div>
        </div>
      </div>
    </div>
  );
}

function DashboardHeader({ model }: { model: DashboardVNextModel }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <header className="capiro-dash__header">
      <p className="capiro-dash__eyebrow">{model.header.eyebrow}</p>
      <h1 className="capiro-dash__greeting">{model.header.greeting}</h1>
      <p className="capiro-dash__meta">{model.header.meta}</p>

      <div className="capiro-dash__header-actions">
        <button
          ref={triggerRef}
          type="button"
          className="capiro-dash__customize capiro-elevation-control"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Customize
        </button>
        {model.header.refreshedLabel ? (
          <span className="capiro-dash__refreshed">{model.header.refreshedLabel}</span>
        ) : null}
      </div>

      {open ? <CustomizeDrawer model={model} onClose={() => setOpen(false)} /> : null}
    </header>
  );
}

/* ── Needs Attention ─────────────────────────────────────────────────────── */

function NeedsAttention({ model }: { model: DashboardVNextModel }) {
  const module = model.needsAttention;

  return (
    <section className="capiro-dash-card capiro-dash-card--attention" aria-label="Needs attention">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Needs Attention</h2>
        <span className="capiro-dash-card__count">
          {module.total > 0
            ? `${module.total} TIME-SENSITIVE ITEM${module.total === 1 ? '' : 'S'}`
            : ''}
        </span>
        {module.total > 0 ? (
          <Link className="capiro-dash-card__link" to="/explorer">
            View all →
          </Link>
        ) : null}
      </div>

      <ModuleStateView status={module.status} onRetry={model.retry} />

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
        {/* Mobile collapses context and due into one meta line (`759:2662`). */}
        <span className="capiro-dash-attention__mobile-meta">
          {[item.context, item.due].filter(Boolean).join(' · ')}
        </span>
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

      <ModuleStateView status={module.status} onRetry={model.retry} />

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
            {/* Tablet and mobile fold relevance and clients into one line. */}
            <span className="capiro-dash-news__narrow-meta">
              {[item.reason, item.clients].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className="capiro-dash-news__client">{item.clients}</span>
        </a>
      ))}
    </section>
  );
}

/* ── Today & Coming Up ───────────────────────────────────────────────────── */

function TodayAndComingUp({ model }: { model: DashboardVNextModel }) {
  const module = model.today;

  return (
    <section className="capiro-dash-card" aria-label="Today and coming up">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Today &amp; Coming Up</h2>
        <Link className="capiro-dash-card__link" to="/engagement">
          Open Engagement
        </Link>
      </div>

      {/* The week strip is desktop-only: the tablet artifact (`758:2831`) drops
          it and goes straight to the event list. */}
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

      <ModuleStateView status={module.status} onRetry={model.retry} />

      {module.events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </section>
  );
}

function eventActionLabel(action: DashboardVNextModel['today']['events'][number]['action']) {
  if (action === 'join') return 'Join';
  if (action === 'prepare') return 'Prepare';
  if (action === 'brief') return 'Brief';
  return 'Open';
}

function EventRow({ event }: { event: DashboardVNextModel['today']['events'][number] }) {
  const body = (
    <>
      <span className="capiro-dash-event__time">{event.time}</span>
      <span className="capiro-dash-event__copy">
        <span className="capiro-dash-event__title">{event.title}</span>
        <span className="capiro-dash-event__meta">{event.meta}</span>
      </span>
      <span className="capiro-dash-event__action">{eventActionLabel(event.action)}</span>
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

/**
 * Mobile Next Meeting (`759:2683`) — the single-card content model that replaces
 * Today & Coming Up below 640px. When nothing is scheduled the module still
 * renders its state rather than disappearing.
 */
function NextMeetingCard({ model }: { model: DashboardVNextModel }) {
  const event = model.today.nextMeeting;

  if (!event) {
    return (
      <section className="capiro-dash-card" aria-label="Next meeting">
        <ModuleStateView status={model.today.status} onRetry={model.retry} />
      </section>
    );
  }

  const action = (
    <span className="capiro-dash-next__action">{eventActionLabel(event.action)}</span>
  );

  const body = (
    <>
      <span className="capiro-dash-next__eyebrow">NEXT MEETING · {event.time}</span>
      <span className="capiro-dash-next__title">{event.title}</span>
      <span className="capiro-dash-next__meta">{event.meta}</span>
      {action}
    </>
  );

  if (event.action === 'join' && event.joinUrl) {
    return (
      <a
        className="capiro-dash-next"
        aria-label="Next meeting"
        href={event.joinUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        {body}
      </a>
    );
  }

  return event.href ? (
    <Link className="capiro-dash-next" aria-label="Next meeting" to={event.href}>
      {body}
    </Link>
  ) : (
    <div className="capiro-dash-next" aria-label="Next meeting">
      {body}
    </div>
  );
}

/* ── Work Queue ──────────────────────────────────────────────────────────── */

function WorkQueue({ model }: { model: DashboardVNextModel }) {
  const module = model.workQueue;

  return (
    <section className="capiro-dash-card" aria-label="Work queue">
      <div className="capiro-dash-card__head">
        <h2 className="capiro-dash-card__title">Work Queue</h2>
        <span className="capiro-dash-card__count">{module.total > 0 ? module.total : ''}</span>
        <Link className="capiro-dash-card__link" to="/workspace">
          View all
        </Link>
      </div>

      <ModuleStateView status={module.status} onRetry={model.retry} />

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

/** Mobile collapses the queue to its lead item with no card header (`759:2689`). */
function MobileWorkQueue({ model }: { model: DashboardVNextModel }) {
  const item = model.workQueue.items[0];

  if (!item) {
    return (
      <section className="capiro-dash-card" aria-label="Work queue">
        <ModuleStateView status={model.workQueue.status} onRetry={model.retry} />
      </section>
    );
  }

  return (
    <Link className="capiro-dash-next capiro-dash-next--work" aria-label="Work queue" to={item.href}>
      <span className="capiro-dash-next__eyebrow">{item.kind}</span>
      <span className="capiro-dash-next__title">{item.title}</span>
      <span className="capiro-dash-next__status">{item.status}</span>
    </Link>
  );
}

/* ── Shared system states (Figma 754:2885) ──────────────────────────────── */

/**
 * The six named states. Each one carries the source fact that justifies it —
 * a failed source is never rendered as empty and a missing value is never
 * rendered as zero (`760:2692`).
 */
function ModuleStateView({ status, onRetry }: { status: ModuleStatus; onRetry: () => void }) {
  if (status.state === 'ready') return null;

  const showsSkeleton = status.state === 'loading' || status.state === 'partial';

  return (
    <div className="capiro-dash-state" data-state={status.state}>
      <div className="capiro-dash-state__head">
        <span className="capiro-dash-state__badge" data-state={status.state}>
          {STATE_LABELS[status.state]}
        </span>
        {status.meta ? <span className="capiro-dash-state__meta">{status.meta}</span> : null}
      </div>

      {status.title ? <p className="capiro-dash-state__title">{status.title}</p> : null}
      {status.body ? <p className="capiro-dash-state__body">{status.body}</p> : null}

      {showsSkeleton ? (
        <div className="capiro-dash-state__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {status.action ? (
        status.action.tone === 'warning' ? (
          <button
            type="button"
            className="capiro-dash-state__action"
            data-tone="warning"
            onClick={onRetry}
          >
            {status.action.label} →
          </button>
        ) : (
          <Link className="capiro-dash-state__action" data-tone={status.action.tone} to="/explorer">
            {status.action.label} →
          </Link>
        )
      ) : null}
    </div>
  );
}

const STATE_LABELS: Readonly<Record<ModuleStatus['state'], string>> = {
  loading: 'LOADING',
  ready: '',
  partial: 'PARTIAL',
  stale: 'STALE',
  unavailable: 'SOURCE UNAVAILABLE',
  empty: 'EMPTY',
  'all-clear': 'ALL CLEAR',
};
