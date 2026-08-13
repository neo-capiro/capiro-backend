import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Form } from 'antd';
import {
  useDashboardVNextModel,
  type AttentionItem,
  type DashboardModuleKey,
  type DashboardVNextModel,
  type ModuleStatus,
  type TodayEvent,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import { JoinButton, SendMeriButton } from '../../../pages/engagement/meetings/meetings-ui.js';
import { NotetakerConsentFields } from '../../../pages/engagement/meeting-actions.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CustomizeDrawer } from './CustomizeDrawer.js';
import './dashboard.css';

/**
 * Dashboard vNext, reskinned onto the purchased Untitled UI kit
 * (`Capiro Dashboard - Untitled UI.dc.html`, Figma `748:2503`).
 *
 * This is a presentation-only reskin. useDashboardVNextModel and every
 * behavioral guarantee it carries (endpoint ownership, the Needs Attention
 * allowlist, the 7-state contract, all-client scope, Send Meri) are
 * completely unchanged — see IMPLEMENTATION_CONTRACT.md, which still governs
 * this component even though its class names no longer match the doc's
 * literal CSS selectors. Ship gate `760:2736` still applies.
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
      <div className="uui-dash" data-density={model.density} data-viewport="mobile">
        <DashboardHeader model={model} />
        <div className="uui-dash__content">
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
    <div className="uui-dash" data-density={model.density}>
      <DashboardHeader model={model} />

      <div className="uui-dash__content">
        {/* Needs Attention is permanently pinned first and is not hideable. */}
        <NeedsAttention model={model} />

        <div className="uui-dash__columns">
          {lead ? modules[lead] : null}
          <div className="uui-dash__stack">{rest.map((key) => modules[key])}</div>
        </div>
      </div>
    </div>
  );
}

function DashboardHeader({ model }: { model: DashboardVNextModel }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <header className="uui-dash__header">
      <div className="uui-dash__header-copy">
        <h1 className="uui-dash__greeting">{model.header.greeting}</h1>
        <p className="uui-dash__meta">{model.header.eyebrow ? `${model.header.eyebrow} · ` : ''}{model.header.meta}</p>
      </div>

      <div className="uui-dash__header-actions">
        {model.header.refreshedLabel ? (
          <span className="uui-dash__refreshed">{model.header.refreshedLabel}</span>
        ) : null}
        <button
          ref={triggerRef}
          type="button"
          className="uui-dash__customize"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Customize
        </button>
      </div>

      {open ? <CustomizeDrawer model={model} onClose={() => setOpen(false)} /> : null}
    </header>
  );
}

/* ── Needs Attention ─────────────────────────────────────────────────────── */

function NeedsAttention({ model }: { model: DashboardVNextModel }) {
  const module = model.needsAttention;

  return (
    <section className="uui-dash-card" aria-label="Needs attention">
      <div className="uui-dash-card__head">
        <h2 className="uui-dash-card__title">Needs Attention</h2>
        {/* Partial renders as a compact chip on the header row, not a body block. */}
        {module.status.state === 'partial' ? (
          <span className="uui-pill uui-dash-card__state-chip" data-tone="gray">
            <span className="uui-pill__dot" aria-hidden="true" />
            {module.status.meta ?? 'Partial'}
          </span>
        ) : null}
        {module.total > 0 ? (
          <span className="uui-dash-card__badge">
            {module.total} item{module.total === 1 ? '' : 's'}
          </span>
        ) : null}
        {module.total > 0 ? (
          <Link className="uui-dash-card__link" to="/explorer">
            View all
          </Link>
        ) : null}
      </div>

      {/* Partial is suppressed here (chip above); ready rows render underneath. */}
      {module.status.state === 'partial' ? null : (
        <ModuleStateView status={module.status} onRetry={model.retry} />
      )}

      {module.items.map((item, index) => (
        <AttentionRow key={item.id} item={item} current={index === 0} />
      ))}
    </section>
  );
}

/**
 * Badge tone rides the severity axis; the badge label is derived honestly
 * (Critical / Deadline / Hearing / …), never a repeated stamp.
 */
function badgeTone(item: AttentionItem): 'error' | 'warning' | 'blue' | 'gray' {
  if (item.severity === 'critical') return 'error';
  if (item.severity === 'high') return 'warning';
  if (item.kind === 'Budget') return 'blue';
  return 'gray';
}

function AttentionRow({ item, current }: { item: AttentionItem; current: boolean }) {
  const body = (
    <>
      <span className="uui-pill" data-tone={badgeTone(item)}>
        <span className="uui-pill__dot" aria-hidden="true" />
        {item.kind}
      </span>
      <span className="uui-dash-attention__copy">
        <span className="uui-dash-attention__title">{item.title}</span>
        <span className="uui-dash-attention__eyebrow">
          {item.eyebrow}
          {item.similarCount > 0 ? (
            <span className="uui-dash-attention__similar"> · +{item.similarCount} similar</span>
          ) : null}
        </span>
        {/* Mobile collapses context and due into one meta line (`759:2662`). */}
        <span className="uui-dash-attention__mobile-meta">
          {[item.context, item.due].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="uui-dash-attention__context">{item.context}</span>
      <span className="uui-dash-attention__due">{item.due}</span>
      <span className="uui-dash-attention__action" data-hierarchy={current ? 'primary' : 'secondary'}>
        {item.actionLabel}
      </span>
    </>
  );

  // Exactly one primary action per decision region: the lead row is "current"
  // and owns the solid button; every other row gets the outlined one.
  return item.href ? (
    <Link
      className="uui-dash-attention"
      data-severity={item.severity}
      data-current={current || undefined}
      to={item.href}
    >
      {body}
    </Link>
  ) : (
    <div
      className="uui-dash-attention"
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
    <section className="uui-dash-card uui-dash-card--news" aria-label="News and narrative">
      <div className="uui-dash-card__head">
        <h2 className="uui-dash-card__title">News &amp; Narrative</h2>
        <span className="uui-dash-card__meta">{module.meta}</span>
        <Link className="uui-dash-card__link" to="/explorer">
          Customize feed
        </Link>
      </div>

      <ModuleStateView status={module.status} onRetry={model.retry} />

      {module.items.map((item) => (
        <a
          key={item.id}
          className="uui-dash-news"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span className="uui-dash-news__thumb" aria-hidden="true">
            {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : null}
          </span>
          <span className="uui-dash-news__copy">
            <span className="uui-dash-news__source">{item.source}</span>
            <span className="uui-dash-news__title">{item.title}</span>
            <span className="uui-dash-news__reason">{item.reason}</span>
            {/* Tablet and mobile fold relevance and clients into one line. */}
            <span className="uui-dash-news__narrow-meta">
              {[item.reason, item.clients].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className="uui-dash-news__client">{item.clients}</span>
        </a>
      ))}
    </section>
  );
}

/* ── Today & Coming Up ───────────────────────────────────────────────────── */

function TodayAndComingUp({ model }: { model: DashboardVNextModel }) {
  const module = model.today;

  return (
    <section className="uui-dash-card" aria-label="Today and coming up">
      <div className="uui-dash-card__head">
        <h2 className="uui-dash-card__title">Today &amp; Coming Up</h2>
        <Link className="uui-dash-card__link" to="/engagement">
          Open Engagement
        </Link>
      </div>

      {/* The week strip is desktop-only: the tablet artifact (`758:2831`) drops
          it and goes straight to the event list. */}
      {module.week.length > 0 ? (
        <div className="uui-dash-week">
          {module.week.map((day) => (
            <div
              key={day.id}
              className="uui-dash-week__day"
              data-today={day.today || undefined}
            >
              <span className="uui-dash-week__weekday">{day.weekday}</span>
              <span className="uui-dash-week__number">{day.day}</span>
              <span
                className="uui-dash-week__dot"
                data-visible={day.hasEvents || undefined}
                aria-hidden="true"
              />
            </div>
          ))}
        </div>
      ) : null}

      <ModuleStateView status={module.status} onRetry={model.retry} />

      {module.events.map((event) => (
        <EventRow key={event.id} event={event} onSendMeri={() => module.sendMeri.open(event.id)} />
      ))}

      <SendMeriDialog
        sendMeri={module.sendMeri}
        event={module.events.find((event) => event.id === module.sendMeri.targetEventId) ?? null}
      />
    </section>
  );
}

function eventActionLabel(action: DashboardVNextModel['today']['events'][number]['action']) {
  if (action === 'join') return 'Join';
  if (action === 'prepare') return 'Prepare';
  if (action === 'brief') return 'Brief';
  return 'Open';
}

function EventRow({
  event,
  onSendMeri,
}: {
  event: TodayEvent;
  onSendMeri: () => void;
}) {
  const copy = (
    <span className="uui-dash-event__copy">
      <span className="uui-dash-event__title">{event.title}</span>
      <span className="uui-dash-event__meta">{event.meta}</span>
    </span>
  );

  // Hearings, comment deadlines and other tracked (non-meeting) items keep the
  // single Prepare/Open/Brief action the row has always had — Join/Send Meri
  // only apply to real meetings, per the rule that a tracked item never gets a
  // fabricated meeting action just because it sits in the same list.
  if (!event.isMeeting) {
    const body = (
      <>
        <span className="uui-dash-event__time">{event.time}</span>
        {copy}
        <span className="uui-dash-event__action">{eventActionLabel(event.action)}</span>
      </>
    );
    if (event.action === 'join' && event.joinUrl) {
      return (
        <a className="uui-dash-event" href={event.joinUrl} target="_blank" rel="noreferrer noopener">
          {body}
        </a>
      );
    }
    return event.href ? (
      <Link className="uui-dash-event" to={event.href}>
        {body}
      </Link>
    ) : (
      <div className="uui-dash-event">{body}</div>
    );
  }

  // Real meetings: Join and Send Meri are independent controls, not one
  // row-wide link, so each keeps its own click target and stops propagation
  // (both JoinButton and SendMeriButton already do this) rather than also
  // firing row navigation.
  return (
    <div className="uui-dash-event uui-dash-event--meeting">
      <span className="uui-dash-event__time">{event.time}</span>
      {event.href ? (
        <Link className="uui-dash-event__copy-link" to={event.href}>
          {copy}
        </Link>
      ) : (
        copy
      )}
      <span className="uui-dash-event__meeting-actions">
        <JoinButton m={{ isVirtual: event.isVirtual, joinLink: event.joinUrl }} size="sm" />
        <SendMeriButton
          m={{ isVirtual: event.isVirtual, joinLink: event.joinUrl, meri: event.meri }}
          size="sm"
          className="uui-dash-send-meri"
          onClick={onSendMeri}
        />
      </span>
    </div>
  );
}

/**
 * Send Meri consent dialog. Reuses the exact `POST …/notetaker` mutation
 * (`model.today.sendMeri`) and the compliance-reviewed consent copy
 * (`NotetakerConsentFields`, meeting-actions.tsx) that HomePage's dashboard
 * strip already dispatches — not a forked copy or a new endpoint.
 *
 * `NotetakerConsentFields` is an antd `Form.Item` tree (it needs Form context
 * to bind its fields), so this is a deliberate, narrow exception to vNext's
 * antd-free rule: the dialog chrome (CapiroModal, CapiroButton) is vNext, but
 * the fields themselves render with antd's own Form.Item spacing/typography
 * because that is the literal reused component, not a re-skin of it. Forking
 * this copy is explicitly what the compliance review prohibits.
 */
function SendMeriDialog({
  sendMeri,
  event,
}: {
  sendMeri: DashboardVNextModel['today']['sendMeri'];
  event: TodayEvent | null;
}) {
  const [form] = Form.useForm();
  const authorized = Form.useWatch('authorizedToRecord', form);
  const notified = Form.useWatch('allPartiesWillBeNotified', form);
  const open = Boolean(event);
  const eventId = event?.id;
  const joinUrl = event?.joinUrl;

  // antd only reads `initialValues` on the Form's first mount, and this dialog
  // stays mounted (just toggling `open`) across different meetings — so a
  // second meeting opened after the first would otherwise keep showing the
  // first meeting's typed values. Re-seed explicitly on every new target,
  // matching HomePage's own openNotetaker(meeting) => setFieldsValue(...).
  useEffect(() => {
    if (!eventId) return;
    form.resetFields();
    form.setFieldsValue({ meetingUrl: joinUrl ?? '' });
  }, [eventId, joinUrl, form]);

  return (
    <CapiroModal open={open} title="Send Meri to take notes?" onClose={sendMeri.close}>
      {event ? (
        <Form form={form} layout="vertical" onFinish={(values) => sendMeri.submit(values.meetingUrl)}>
          <NotetakerConsentFields />
          <div className="uui-dash-send-meri-dialog__actions">
            <CapiroButton variant="secondary" onClick={sendMeri.close} disabled={sendMeri.pending}>
              Cancel
            </CapiroButton>
            <CapiroButton
              variant="primary"
              onClick={() => form.submit()}
              disabled={!(authorized && notified) || sendMeri.pending}
              loading={sendMeri.pending}
            >
              Send Meri
            </CapiroButton>
          </div>
        </Form>
      ) : null}
    </CapiroModal>
  );
}

/**
 * Mobile Next Meeting (`759:2683`) — the single-card content model that replaces
 * Today & Coming Up below 780px (useIsMobile is pinned to the canonical 779
 * boundary, so this content model and dashboard.css's mobile geometry now
 * switch on the same pixel). The Join affordance is real, not decorative: the
 * model resolves `nextMeeting.joinUrl` from the same `readJoinUrl` the desktop
 * rows use. When nothing is scheduled the module still renders its state rather
 * than disappearing.
 */
function NextMeetingCard({ model }: { model: DashboardVNextModel }) {
  const event = model.today.nextMeeting;

  if (!event) {
    return (
      <section className="uui-dash-card" aria-label="Next meeting">
        <ModuleStateView status={model.today.status} onRetry={model.retry} />
      </section>
    );
  }

  const action = (
    <span className="uui-dash-next__action">{eventActionLabel(event.action)}</span>
  );

  const body = (
    <>
      <span className="uui-dash-next__eyebrow">NEXT MEETING · {event.time}</span>
      <span className="uui-dash-next__title">{event.title}</span>
      <span className="uui-dash-next__meta">{event.meta}</span>
      {action}
    </>
  );

  if (event.action === 'join' && event.joinUrl) {
    return (
      <a
        className="uui-dash-next"
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
    <Link className="uui-dash-next" aria-label="Next meeting" to={event.href}>
      {body}
    </Link>
  ) : (
    <div className="uui-dash-next" aria-label="Next meeting">
      {body}
    </div>
  );
}

/* ── Work Queue ──────────────────────────────────────────────────────────── */

function WorkQueue({ model }: { model: DashboardVNextModel }) {
  const module = model.workQueue;

  return (
    <section className="uui-dash-card" aria-label="Work queue">
      <div className="uui-dash-card__head">
        <h2 className="uui-dash-card__title">Work Queue</h2>
        {module.total > 0 ? <span className="uui-dash-card__meta">{module.total} open</span> : null}
        <Link className="uui-dash-card__link" to="/workspace">
          View all
        </Link>
      </div>

      <ModuleStateView status={module.status} onRetry={model.retry} />

      {module.items.map((item) => (
        <Link key={item.id} className="uui-dash-work" to={item.href}>
          <span className="uui-pill" data-tone="gray">{item.kind}</span>
          <span className="uui-dash-work__title">{item.title}</span>
          <span className="uui-pill" data-tone={workStatusTone(item.status)}>{item.status}</span>
        </Link>
      ))}
    </section>
  );
}

/** Purely cosmetic: color the status pill by its own text, never a new field. */
function workStatusTone(status: string): 'success' | 'blue' | 'warning' | 'gray' {
  const lower = status.toLowerCase();
  if (lower.includes('ready') || lower.includes('sent')) return 'success';
  if (lower.includes('progress')) return 'blue';
  if (lower.includes('needs') || lower.includes('draft')) return 'warning';
  return 'gray';
}

/** Mobile collapses the queue to its lead item with no card header (`759:2689`). */
function MobileWorkQueue({ model }: { model: DashboardVNextModel }) {
  const item = model.workQueue.items[0];

  if (!item) {
    return (
      <section className="uui-dash-card" aria-label="Work queue">
        <ModuleStateView status={model.workQueue.status} onRetry={model.retry} />
      </section>
    );
  }

  return (
    <Link className="uui-dash-next uui-dash-next--work" aria-label="Work queue" to={item.href}>
      <span className="uui-dash-next__eyebrow">{item.kind}</span>
      <span className="uui-dash-next__title">{item.title}</span>
      <span className="uui-dash-next__status">{item.status}</span>
    </Link>
  );
}

/* ── Shared system states (Figma 754:2885) ──────────────────────────────── */

/**
 * The seven named states from useDashboardVNextModel (loading/ready/partial/
 * stale/unavailable/empty/all-clear). Each one carries the source fact that
 * justifies it — a failed source is never rendered as empty and a missing
 * value is never rendered as zero (`760:2692`).
 */
function ModuleStateView({ status, onRetry }: { status: ModuleStatus; onRetry: () => void }) {
  if (status.state === 'ready') return null;

  const showsSkeleton = status.state === 'loading' || status.state === 'partial';

  return (
    <div className="uui-dash-state" data-state={status.state}>
      <div className="uui-dash-state__head">
        <span className="uui-pill" data-tone={STATE_TONES[status.state]}>
          <span className="uui-pill__dot" aria-hidden="true" />
          {STATE_LABELS[status.state]}
        </span>
        {status.meta ? <span className="uui-dash-state__meta">{status.meta}</span> : null}
      </div>

      {status.title ? <p className="uui-dash-state__title">{status.title}</p> : null}
      {status.body ? <p className="uui-dash-state__body">{status.body}</p> : null}

      {showsSkeleton ? (
        <div className="uui-dash-state__skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {status.action ? (
        status.action.tone === 'warning' ? (
          <button
            type="button"
            className="uui-dash-state__action"
            data-tone="warning"
            onClick={onRetry}
          >
            {status.action.label} →
          </button>
        ) : (
          <Link className="uui-dash-state__action" data-tone={status.action.tone} to="/explorer">
            {status.action.label} →
          </Link>
        )
      ) : null}
    </div>
  );
}

const STATE_LABELS: Readonly<Record<ModuleStatus['state'], string>> = {
  loading: 'Loading',
  ready: '',
  partial: 'Partial',
  stale: 'Stale',
  unavailable: 'Source unavailable',
  empty: 'Empty',
  'all-clear': 'All clear',
};

const STATE_TONES: Readonly<Record<ModuleStatus['state'], 'gray' | 'warning' | 'success'>> = {
  loading: 'gray',
  ready: 'gray',
  partial: 'gray',
  stale: 'warning',
  unavailable: 'warning',
  empty: 'gray',
  'all-clear': 'success',
};
