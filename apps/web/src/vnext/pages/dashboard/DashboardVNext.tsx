import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  useDashboardVNextModel,
  type AttentionItem,
  type DashboardVNextModel,
  type TodayEvent,
  type XFeedPostItem,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import { CustomizeDrawer } from './CustomizeDrawer.js';
import { useMarkLwNotificationRead } from '../legiwatch/lib/wave1-api.js';
// The mutation lives in the connected DashboardVNext wrapper, not the view.
import { resolveNewsOutletMark } from './news-outlet-logos.js';
import type { NewsLookback } from '../../../pages/dashboard/news-preferences.js';
import './dashboard.css';
import { usePlannerQueue } from '../planner/planner-api.js';
import type { PlannerTask } from '@capiro/strategy-verifier';
import { PLANNER_STATUS_LABELS } from '@capiro/strategy-verifier';

type WireFilter = 'all' | 'x' | 'news';
type WireItem =
  | { type: 'x'; id: string; at: number; item: XFeedPostItem }
  | { type: 'news'; id: string; at: number; item: DashboardVNextModel['news']['items'][number] };

type AttentionTone = 'error' | 'warning' | 'blue';

/**
 * Cards-per-page for the Needs Attention carousel. Mirrors this file's own
 * breakpoints (1099/779, asserted by dashboard-contract.test.ts) rather than
 * inventing a third — the dot count and arrow disabled-state are computed in
 * JS, so they must track the same cutovers the CSS uses for --per-page.
 */
function subscribeAttentionPerPage(callback: () => void) {
  const queries = [window.matchMedia('(max-width: 1099px)'), window.matchMedia('(max-width: 779px)')];
  queries.forEach((query) => query.addEventListener('change', callback));
  return () => queries.forEach((query) => query.removeEventListener('change', callback));
}
function readAttentionPerPage() {
  if (window.matchMedia('(max-width: 779px)').matches) return 1;
  if (window.matchMedia('(max-width: 1099px)').matches) return 2;
  return 4;
}
function useAttentionPerPage() {
  return useSyncExternalStore(subscribeAttentionPerPage, readAttentionPerPage, () => 4);
}

export function DashboardVNext() {
  const markLwRead = useMarkLwNotificationRead();
  const planner = usePlannerQueue();
  const plannerQueue = {
    items: planner.data ?? [],
    unavailable: planner.isError,
  };
  return (
    <DashboardVNextView
      model={useDashboardVNextModel()}
      plannerQueue={plannerQueue}
      onClearAttention={(item, finish, fail) => {
        // Committee/hearing rows are durable: mark read FIRST, navigate only
        // on success so the bell badge + this module agree after a reload.
        // A failed read restores the row and shows the inline error.
        if (item.attentionSource === 'lw-notification') {
          const lwId = item.id.slice('lw-notif-'.length);
          markLwRead.mutate(lwId, { onSuccess: finish, onError: fail });
          return;
        }
        finish();
      }}
    />
  );
}

export function DashboardVNextView({
  model,
  onClearAttention,
  plannerQueue,
}: {
  model: DashboardVNextModel;
  plannerQueue?: { items: PlannerTask[]; unavailable: boolean };
  /** Connected wrapper supplies the lw read-then-navigate behavior. Optional
   *  so fixture renders of the pure view need no QueryClient. */
  onClearAttention?: (item: AttentionItem, finish: () => void, fail: () => void) => void;
}) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [customizeSection, setCustomizeSection] = useState<'x' | null>(null);
  const [wireFilter, setWireFilter] = useState<WireFilter>('all');
  const [showAllWire, setShowAllWire] = useState(false);
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  const [clearedAttentionIds, setClearedAttentionIds] = useState<Set<string>>(() => new Set());
  const [clearingAttentionIds, setClearingAttentionIds] = useState<Set<string>>(() => new Set());
  const [attentionPage, setAttentionPage] = useState(0);
  const [densityChanging, setDensityChanging] = useState(false);

  const attentionItems = model.needsAttention.items.filter((item) => !clearedAttentionIds.has(item.id));
  const criticalCount = attentionItems.filter((item) => item.severity === 'critical').length;
  const attentionPerPage = useAttentionPerPage();
  const attentionPageCount = Math.max(1, Math.ceil(attentionItems.length / attentionPerPage));
  const clampedAttentionPage = Math.min(attentionPage, attentionPageCount - 1);
  useEffect(() => {
    if (clampedAttentionPage !== attentionPage) setAttentionPage(clampedAttentionPage);
  }, [attentionPage, clampedAttentionPage]);
  const laneOrder = model.order.filter((key): key is 'today' | 'work' => key === 'today' || key === 'work');
  const wireEnabled = model.visibility.news || model.visibility.xFeed;
  const hasWorkLane = model.visibility.today || model.visibility.work;

  // Dashboard v2 exposes The Wire as one lane toggle. Normalize any old v1
  // preference where News and X were independently hidden so the new contract
  // cannot render a half-enabled Wire after upgrade.
  useEffect(() => {
    if (model.visibility.news === model.visibility.xFeed) return;
    model.setVisibility({ ...model.visibility, news: wireEnabled, xFeed: wireEnabled });
  }, [model, wireEnabled]);

  const wireItems = useMemo(() => {
    const xItems: WireItem[] = model.xFeed.posts.map((item) => ({
      type: 'x', id: `x-${item.id}`, at: Date.parse(item.createdAtX) || 0, item,
    }));
    const newsItems: WireItem[] = model.news.items.map((item) => ({
      type: 'news', id: `news-${item.id}`, at: Date.parse(item.publishedAt ?? '') || relativeLabelEpoch(item.publishedLabel), item,
    }));
    return [...xItems, ...newsItems].sort((a, b) => b.at - a.at);
  }, [model.news.items, model.xFeed.posts]);

  const wireLimit = model.density === 'presentation' ? 6 : 8;
  // Was hardcoded to 24h regardless of the news module's own Lookback
  // preference (24h/48h/7d, default 48h — see news-preferences.ts), so the
  // Wire silently discarded up to half of whatever the news source actually
  // returned. Windowing on the same preference means the count shown here
  // always matches what was actually fetched.
  const wireWindow = wireItems.filter((item) => item.at >= Date.now() - lookbackMs(model.news.preferences.lookback));
  const filteredWire = wireWindow
    .filter((item) => wireFilter === 'all' || item.type === wireFilter)
    .slice(0, showAllWire ? undefined : wireLimit);
  const hasMoreWire = wireWindow.filter((item) => wireFilter === 'all' || item.type === wireFilter).length > wireLimit;

  const setDensityAnimated = (next: DashboardVNextModel['density']) => {
    if (next === model.density || densityChanging) return;
    setDensityChanging(true);
    window.setTimeout(() => {
      model.setDensity(next);
      window.setTimeout(() => setDensityChanging(false), 95);
    }, 95);
  };

  const doRefresh = () => {
    if (model.xFeed.refreshing) return;
    model.xFeed.refresh();
    model.retry();
  };

  const clearAttention = (item: AttentionItem) => {
    if (clearingAttentionIds.has(item.id)) return;
    setClearingAttentionIds((current) => new Set([...current, item.id]));
    setAttentionError(null);

    const finish = () => {
      setClearedAttentionIds((current) => new Set([...current, item.id]));
      setClearingAttentionIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
      if (selectedAttentionId === item.id) setSelectedAttentionId(null);
      if (item.href) window.location.assign(item.href);
    };
    const fail = () => {
      // The read did not persist — restore the row and say so instead of
      // navigating as if it had been triaged.
      setClearingAttentionIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      setAttentionError('This alert could not be marked read. It is still unread — try again.');
    };

    if (item.attentionSource === 'lw-notification' && onClearAttention) {
      onClearAttention(item, () => window.setTimeout(finish, 260), fail);
      return;
    }
    window.setTimeout(finish, 260);
  };

  return (
    <div
      className="dashv2"
      data-density={model.density}
      data-two-lane={wireEnabled && hasWorkLane || undefined}
      data-density-changing={densityChanging || undefined}
    >
      <section className="dashv2-console">
        <div className="dashv2-head">
          <div className="dashv2-head__copy">
            <h1>{model.header.greeting}</h1>
            <span className="dashv2-head__date"><span className="dashv2-head__date-long">{formatLongDate()}</span><span className="dashv2-head__date-short">{formatShortDate()}</span></span>
          </div>
          <div className="dashv2-head__actions">
            <button className="dashv2-refresh" type="button" onClick={doRefresh} disabled={model.xFeed.refreshing} title="Refresh dashboard sources">
              <DashboardIcon name="RefreshCw01" size={18} className={model.xFeed.refreshing ? 'dashv2-spin' : undefined} />
              <span>{model.xFeed.refreshing ? 'Refreshing…' : (model.header.refreshedLabel || 'Refresh')}</span>
            </button>
            <button className="dashv2-primary" type="button" onClick={() => { setCustomizeSection(null); setCustomizeOpen(true); }}>
              <DashboardIcon name="Sliders02" size={18} />
              <span>Customize</span>
            </button>
          </div>
        </div>

        <div className="dashv2-triage" aria-label="Needs attention" aria-roledescription={attentionPageCount > 1 ? 'carousel' : undefined}>
          <div className="dashv2-triage__eyebrow">
            <span>NEEDS ATTENTION</span>
            <span key={`${attentionItems.length}-${criticalCount}`} className="dashv2-pill dashv2-triage__count" data-tone={criticalCount > 0 ? 'error' : 'warning'}>
              <span className="dashv2-pill__dot" />
              {attentionCountBase(model, attentionItems.length)}{criticalCount > 0 && model.needsAttention.status.state !== 'loading' && model.needsAttention.status.state !== 'unavailable' ? <span className="dashv2-triage__critical"> · {criticalCount} critical</span> : null}
            </span>
            <span className="dashv2-triage__spacer" />
            {attentionPageCount > 1 ? (
              <span className="dashv2-attn-controls">
                <span className="dashv2-attn-dots" role="tablist" aria-label="Pages">
                  {Array.from({ length: attentionPageCount }, (_, page) => (
                    <button
                      key={page}
                      type="button"
                      role="tab"
                      className="dashv2-attn-dot"
                      aria-selected={page === clampedAttentionPage}
                      aria-label={`Page ${page + 1} of ${attentionPageCount}`}
                      onClick={() => setAttentionPage(page)}
                    />
                  ))}
                </span>
                <button type="button" className="dashv2-icon-button dashv2-attn-arrow" aria-label="Previous" aria-controls="dashv2-attn-track" disabled={clampedAttentionPage === 0} onClick={() => setAttentionPage((page) => page - 1)}>
                  <span className="dashv2-attn-arrow__glyph"><DashboardIcon name="ChevronRight" size={17} /></span>
                </button>
                <button type="button" className="dashv2-icon-button dashv2-attn-arrow" aria-label="Next" aria-controls="dashv2-attn-track" disabled={clampedAttentionPage >= attentionPageCount - 1} onClick={() => setAttentionPage((page) => page + 1)}>
                  <DashboardIcon name="ChevronRight" size={17} />
                </button>
              </span>
            ) : null}
          </div>

          {attentionError ? (
            <div className="dashv2-source-state" role="alert">
              <strong>Committee alert not marked read</strong>
              <span>{attentionError}</span>
            </div>
          ) : null}
          {model.needsAttention.status.state === 'loading' ? (
            <div className="dashv2-allclear" data-state="loading">Loading time-sensitive signals…</div>
          ) : model.needsAttention.status.state === 'unavailable' ? (
            <div className="dashv2-source-state"><strong>Needs Attention is temporarily unavailable</strong><span>{model.needsAttention.status.meta ?? 'A required source did not respond.'}</span><button type="button" className="dashv2-link" onClick={model.retry}>Retry source</button></div>
          ) : attentionItems.length === 0 ? (
            <div className="dashv2-allclear">
              <span className="dashv2-allclear__dot" />
              <strong>Nothing time-sensitive right now.</strong>
              <span>Next source check will appear here automatically.</span>
              <span className="dashv2-triage__spacer" />
              <button type="button" className="dashv2-link dashv2-link--success" onClick={model.retry}>Check now</button>
            </div>
          ) : (
            <div className="dashv2-attn-viewport">
              <div
                className="dashv2-attn-track"
                id="dashv2-attn-track"
                role="list"
                style={{ '--per-page': attentionPerPage, '--page': clampedAttentionPage } as CSSProperties}
              >
                {attentionItems.map((item, index) => (
                  <TriageTile
                    key={item.id}
                    item={item}
                    index={index}
                    total={attentionItems.length}
                    selected={selectedAttentionId === item.id}
                    clearing={clearingAttentionIds.has(item.id)}
                    onSelect={() => setSelectedAttentionId((current) => current === item.id ? null : item.id)}
                    onAction={() => clearAttention(item)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="dashv2-grid">
        <div className="dashv2-worklane">
          {laneOrder.map((key) => {
            if (key === 'today' && model.visibility.today) {
              return <ChronologicalSpine key="today" model={model} selectedAttentionId={selectedAttentionId} onSelectAttention={setSelectedAttentionId} />;
            }
            if (key === 'work' && model.visibility.work) return <WorkQueue key="work" model={model} plannerQueue={plannerQueue} />;
            return null;
          })}
        </div>
        {wireEnabled ? (
          <Wire
            model={model}
            filter={wireFilter}
            onFilter={setWireFilter}
            items={filteredWire}
            windowItems={wireWindow}
            showAll={showAllWire}
            hasMore={hasMoreWire}
            onToggleShowAll={() => setShowAllWire((value) => !value)}
            onManage={() => { setCustomizeSection('x'); setCustomizeOpen(true); }}
            onRefresh={doRefresh}
          />
        ) : null}
      </div>

      {customizeOpen ? <CustomizeDrawer model={model} initialSection={customizeSection} onClose={() => { setCustomizeOpen(false); setCustomizeSection(null); }} onDensityChange={setDensityAnimated} /> : null}
    </div>
  );
}

function TriageTile({ item, index, total, selected, clearing, onSelect, onAction }: { item: AttentionItem; index: number; total: number; selected: boolean; clearing: boolean; onSelect: () => void; onAction: () => void }) {
  const tone = attentionTone(item);
  return (
    <div
      role="listitem"
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${total}`}
      tabIndex={0}
      className="dashv2-tile"
      data-tone={tone}
      data-selected={selected || undefined}
      data-clearing={clearing || undefined}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }}
    >
      <span className="dashv2-tile__rail" aria-hidden="true" />
      <div className="dashv2-tile__body">
        <div className="dashv2-tile__top">
          <span className="dashv2-tile__kind">{item.kind}</span>
          <span className="dashv2-triage__spacer" />
          <span className="dashv2-tile__due">{item.due ?? ''}</span>
        </div>
        <div className="dashv2-tile__title">{item.title}</div>
        <div className="dashv2-tile__bottom">
          <span className="dashv2-tile__context">{[item.eyebrow, item.context].filter(Boolean).join(' · ')}</span>
          <button type="button" className="dashv2-tile__action" onClick={(event) => { event.stopPropagation(); onAction(); }}>
            {item.actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChronologicalSpine({ model, selectedAttentionId, onSelectAttention }: { model: DashboardVNextModel; selectedAttentionId: string | null; onSelectAttention: (id: string | null) => void }) {
  const groups = groupEvents(model.today.events);
  return (
    <section className="dashv2-card dashv2-spine" aria-label="Today and coming up">
      {/* v3: no count pill in the card header — the TODAY/TOMORROW/LATER
          groupings below already carry that context; a single header action
          stays, per the handoff's card restraint rule. */}
      <header className="dashv2-card__head dashv2-spine__head">
        <h2>Today &amp; Coming Up</h2>
        <span className="dashv2-triage__spacer" />
        <Link className="dashv2-link" to="/engagement">Open calendar</Link>
      </header>
      <div className="dashv2-spine__body">
        <SpineGroup label={`TODAY · ${dayHeading(new Date())}`} events={groups.today} today model={model} selectedAttentionId={selectedAttentionId} onSelectAttention={onSelectAttention} />
        <SpineGroup label={`TOMORROW · ${dayHeading(addDays(new Date(), 1))}`} events={groups.tomorrow} model={model} selectedAttentionId={selectedAttentionId} onSelectAttention={onSelectAttention} />
        <SpineGroup label="LATER THIS WEEK" events={groups.later} week model={model} selectedAttentionId={selectedAttentionId} onSelectAttention={onSelectAttention} />
      </div>
    </section>
  );
}

function SpineGroup({ label, events, today = false, week = false, model, selectedAttentionId, onSelectAttention }: { label: string; events: TodayEvent[]; today?: boolean; week?: boolean; model: DashboardVNextModel; selectedAttentionId: string | null; onSelectAttention: (id: string | null) => void }) {
  return (
    <div className="dashv2-spine-group" data-today={today || undefined} data-week={week || undefined}>
      <div className="dashv2-spine-group__label"><span>{label}</span><i /></div>
      <div className="dashv2-spine-group__rows">
      <div className="dashv2-spine-group__rail" />
      {today ? (
        <div className="dashv2-now"><span>NOW</span><i className="dashv2-now__node"/><b/><time>{new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time></div>
      ) : null}
      {events.length === 0 ? <div className="dashv2-spine-empty">{today ? 'Nothing scheduled today' : 'Nothing scheduled'}</div> : null}
      {events.map((event) => {
        const attention = matchAttention(event, model.needsAttention.items);
        const selectable = Boolean(attention);
        const selected = attention?.id === selectedAttentionId;
        const kind = event.isMeeting ? 'meeting' : (event.title.toLowerCase().includes('hearing') ? 'hearing' : 'deadline');
        const content = (
          <>
            <span className="dashv2-spine-row__time">{week ? weekDayToken(event) : event.time}</span>
            <i className="dashv2-spine-row__node" data-kind={kind}/>
            <span className="dashv2-spine-row__copy"><strong title={event.title}>{event.title}</strong><span title={stripDayPrefix(event.meta)}>{stripDayPrefix(event.meta)}</span></span>
            {event.isMeeting && event.action === 'join' && event.joinUrl ? <a className="dashv2-secondary dashv2-spine-row__action" href={event.joinUrl} target="_blank" rel="noreferrer" onClick={(e)=>e.stopPropagation()}>Join</a> : null}
            {!event.isMeeting && kind === 'hearing' ? <Link className="dashv2-secondary dashv2-spine-row__action" to={event.href ?? '/legiwatch'} onClick={(e)=>e.stopPropagation()}>Brief</Link> : null}
          </>
        );
        return selectable ? (
          <div key={event.id} role="button" tabIndex={0} className="dashv2-spine-row dashv2-spine-row--selectable" data-selected={selected || undefined} onClick={() => onSelectAttention(selected ? null : attention!.id)} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' || keyEvent.key === ' ') { keyEvent.preventDefault(); onSelectAttention(selected ? null : attention!.id); } }}>{content}</div>
        ) : event.href ? (
          <Link key={event.id} to={event.href} className="dashv2-spine-row">{content}</Link>
        ) : <div key={event.id} className="dashv2-spine-row">{content}</div>;
      })}
      </div>
    </div>
  );
}

function WorkQueue({ model, plannerQueue }: { model: DashboardVNextModel; plannerQueue?: { items: PlannerTask[]; unavailable: boolean } }) {
  const limit = model.density === 'presentation' ? 3 : model.density === 'compact' ? 5 : 4;
  const rows = model.workQueue.items.slice(0, limit);
  return (
    <section className="dashv2-card dashv2-work" aria-label="Work queue">
      {/* v3: no header count pill — the total folds into the "View all"
          link text instead, matching the handoff's card restraint rule. */}
      <header className="dashv2-card__head dashv2-work__head"><h2>Work Queue</h2><span className="dashv2-triage__spacer"/><Link className="dashv2-link" to="/workspace">View all {model.workQueue.total}</Link></header>
      {plannerQueue && <Link className="dashv2-link" to="/planner?scope=mine">Open Planner →</Link>}
      {plannerQueue?.unavailable && <p className="dashv2-empty">Planner tasks are temporarily unavailable.</p>}
      {plannerQueue?.items.slice(0, 2).map(task => <Link key={`planner-${task.id}`} className="dashv2-work-row" to={`/planner?task=${task.id}`}><span className="dashv2-work-row__kind">TASK</span><span className="dashv2-work-row__title">{task.name}</span><span className="dashv2-pill dashv2-pill--gray">{PLANNER_STATUS_LABELS[task.status]}</span></Link>)}
      {rows.length === 0 ? <div className="dashv2-empty">No open drafts</div> : rows.map((item) => (
        <Link key={item.id} className="dashv2-work-row" to={item.href}>
          <span className="dashv2-work-row__kind">{item.kind}</span>
          <span className="dashv2-work-row__title">{item.title}</span>
          <span className="dashv2-pill dashv2-pill--gray" data-tone={item.status.toLowerCase().includes('ready') ? 'success' : undefined}><span className="dashv2-pill__dot"/>{item.status}</span>
        </Link>
      ))}
    </section>
  );
}

function Wire({ model, filter, onFilter, items, windowItems, showAll, hasMore, onToggleShowAll, onManage, onRefresh }: { model: DashboardVNextModel; filter: WireFilter; onFilter: (next: WireFilter)=>void; items: WireItem[]; windowItems: WireItem[]; showAll: boolean; hasMore: boolean; onToggleShowAll: () => void; onManage: ()=>void; onRefresh: ()=>void }) {
  const xCount = windowItems.filter((item) => item.type === 'x').length;
  const newsCount = windowItems.filter((item) => item.type === 'news').length;
  const xKnown = sourceCountKnown(model.xFeed.status.state, xCount);
  const newsKnown = sourceCountKnown(model.news.status.state, newsCount);
  const countLabel = filter === 'x'
    ? (xKnown ? `${xCount} posts` : 'X unavailable')
    : filter === 'news'
      ? (newsKnown ? `${newsCount} stories` : 'News unavailable')
      : ([xKnown ? `${xCount} posts` : null, newsKnown ? `${newsCount} stories` : null].filter(Boolean).join(' · ') || 'Sources updating');
  return (
    <aside className="dashv2-card dashv2-wire" aria-label="The Wire">
      {/* v3: no header count pill. countLabel is kept (still real, still
          honors sourceCountKnown so an unavailable source never reads as
          zero) as a hover title rather than a visible pill — the two
          SourceBanners below already state "temporarily unavailable" in
          full when a source is down. */}
      <header className="dashv2-wire__head"><h2 title={countLabel}>The Wire</h2><span className="dashv2-triage__spacer"/><span className="dashv2-wire__window"><span className="dashv2-wire__desktop">Last </span>{WIRE_WINDOW_LABEL[model.news.preferences.lookback]}</span></header>
      <div className="dashv2-wire__filters"><div className="dashv2-segmented">{(['all','x','news'] as const).map((value)=><button key={value} type="button" data-selected={filter===value||undefined} onClick={()=>onFilter(value)}>{value==='all'?'All':value==='x'?'X':'News'}</button>)}</div><button type="button" className="dashv2-link" onClick={onManage}>Manage accounts</button></div>
      <div className="dashv2-wire__list">
        {filter !== 'news' ? <SourceBanner source="x" status={model.xFeed.status.state} hasSubscriptions={model.xFeed.subscriptions.some((sub) => sub.enabled)} onCustomize={onManage} onRetry={onRefresh} /> : null}
        {filter !== 'x' ? <SourceBanner source="news" status={model.news.status.state} hasSubscriptions={model.news.preferences.articleTopics.length > 0 || model.news.preferences.sources.length > 0 || model.news.preferences.agencies.length > 0 || model.news.preferences.customTopics.length > 0} onCustomize={onManage} onRetry={model.retry} /> : null}
        {items.length === 0 ? <div className="dashv2-wire-empty"><strong>Nothing on this filter</strong><span>No items were returned in the current window.</span></div> : items.map((entry) => entry.type === 'x' ? <XWireRow key={entry.id} post={entry.item}/> : <NewsWireRow key={entry.id} item={entry.item}/>) }
        {hasMore ? <button type="button" className="dashv2-wire__more dashv2-link" onClick={onToggleShowAll}>{showAll ? 'Show less' : `View more ${filter === 'x' ? 'X posts' : filter === 'news' ? 'news stories' : 'items'}`}</button> : null}
      </div>
      <footer className="dashv2-wire__foot"><span>{model.xFeed.subscriptions.length} accounts · {model.news.preferences.articleTopics.length} article topics · read-only{wireStaleDisclosure(model)}</span><span className="dashv2-triage__spacer"/><button type="button" className="dashv2-link" onClick={onRefresh}>Refresh</button></footer>
    </aside>
  );
}

function SourceBanner({ source, status, hasSubscriptions, onCustomize, onRetry }: { source: 'x'|'news'; status: string; hasSubscriptions: boolean; onCustomize: ()=>void; onRetry: ()=>void }) {
  if (status === 'ready' || status === 'stale') return null;
  const loading = status === 'loading' || status === 'partial';
  const empty = status === 'empty' || status === 'all-clear';
  if (source === 'x' && empty && hasSubscriptions) return null;
  const title = source === 'x' ? (loading ? 'Refreshing X posts' : empty ? 'No X accounts subscribed' : 'X source is temporarily unavailable') : (loading ? 'Refreshing news' : empty ? 'No stories match these subscriptions' : 'News source is temporarily unavailable');
  const body = source === 'x' ? (loading ? 'Subscribed accounts are being polled. News items are unaffected.' : empty ? 'Add the public accounts you want this dashboard to monitor.' : 'Showing news only. No X posts are being counted as zero.') : (loading ? 'Relevance is being re-scored against your client and issue profiles.' : empty ? 'Adjust news topics in Customize to widen this feed.' : 'The news source is not responding. X posts are unaffected.');
  const action = empty ? onCustomize : onRetry;
  return <div className="dashv2-banner" data-state={loading?'loading':empty?'empty':'unavailable'}><span className="dashv2-banner__icon">{source==='x'?'X':'N'}</span><span><strong>{title}</strong><small>{body}</small>{!loading ? <button type="button" className="dashv2-link" onClick={action}>{empty ? (source==='x'?'Add accounts':'Customize feed') : 'Retry source'}</button> : null}</span></div>;
}

function XWireRow({ post }: { post: XFeedPostItem }) {
  const initials = initialsOf(post.authorDisplayName ?? post.authorUsername);
  return <a className="dashv2-wire-row" href={post.xUrl} target="_blank" rel="noreferrer"><span className="dashv2-wire-row__mark">{post.authorAvatarUrl?<img src={post.authorAvatarUrl} alt=""/>:<span className="dashv2-avatar">{initials}</span>}</span><span className="dashv2-wire-row__copy"><span className="dashv2-wire-row__name"><strong>{post.authorDisplayName ?? post.authorUsername}</strong><i className="dashv2-xchip">X</i></span><span className="dashv2-wire-row__byline">@{post.authorUsername} · {relativeTime(post.createdAtX)}</span><span className="dashv2-wire-row__body">{post.text}</span><span className="dashv2-wire-row__foot"><span/><b>View post</b></span></span></a>;
}

function NewsWireRow({ item }: { item: DashboardVNextModel['news']['items'][number] }) {
  // item.source is "SLUG · relativeDay" from the adapter; the mark map keys on the slug.
  const outlet = resolveNewsOutletMark(item.source);
  const byline = relativeTime(item.publishedAt ?? '') || item.publishedLabel;
  return (
    <a className="dashv2-wire-row" href={item.url} target="_blank" rel="noreferrer">
      <span className="dashv2-wire-row__mark">
        <NewsOutletMark label={outlet.label} logoUrl={outlet.logoUrl} />
      </span>
      <span className="dashv2-wire-row__copy">
        <span className="dashv2-wire-row__name"><strong>{outlet.label}</strong></span>
        <span className="dashv2-wire-row__byline">{byline}</span>
        <span className="dashv2-wire-row__headline">{item.title}</span>
        <span className="dashv2-wire-row__foot">
          {item.clients && item.reason ? <span className="dashv2-pill dashv2-pill--brand">{item.reason}</span> : <span />}
          <b>Read story</b>
        </span>
      </span>
    </a>
  );
}

/** Outlet mark: logo when the favicon resolves, initials otherwise. */
function NewsOutletMark({ label, logoUrl }: { label: string; logoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;
  if (showLogo) {
    return (
      <img
        className="dashv2-outlet dashv2-outlet--logo"
        src={logoUrl ?? undefined}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className="dashv2-outlet">{initialsOf(label)}</span>;
}

function groupEvents(events: TodayEvent[]) {
  const today: TodayEvent[] = [], tomorrow: TodayEvent[] = [], later: TodayEvent[] = [];
  const now = new Date();
  const tomorrowDate = addDays(now, 1);
  for (const event of events) {
    const eventDate = event.startsAt ? new Date(event.startsAt) : null;
    if (eventDate && !Number.isNaN(eventDate.getTime())) {
      if (eventDate.toDateString() === now.toDateString()) today.push(event);
      else if (eventDate.toDateString() === tomorrowDate.toDateString()) tomorrow.push(event);
      else later.push(event);
      continue;
    }
    const first = event.meta.split(' · ')[0]?.trim().toUpperCase();
    const tomorrowCode = tomorrowDate.toLocaleDateString(undefined,{weekday:'short'}).toUpperCase();
    if (first === tomorrowCode) tomorrow.push(event);
    else if (first && /^[A-Z]{3}$/.test(first)) later.push(event);
    else today.push(event);
  }
  return { today, tomorrow, later };
}
function matchAttention(event: TodayEvent, items: AttentionItem[]) { const byHref = event.href ? items.find((item)=>item.href===event.href) : undefined; if (byHref) return byHref; const title=event.title.toLowerCase(); return items.find((item)=>title.includes(item.title.toLowerCase())||item.title.toLowerCase().includes(title)); }
function weekDayToken(event: TodayEvent) {
  if (event.startsAt) {
    const date = new Date(event.startsAt);
    if (!Number.isNaN(date.getTime())) return `${date.toLocaleDateString(undefined,{weekday:'short'}).toUpperCase()} ${date.getDate()}`;
  }
  const day=(event.meta.split(' · ')[0] ?? '').trim().toUpperCase();
  const match=event.time.match(/(\d{1,2})(?!.*\d)/);
  return [day, match?.[1]].filter(Boolean).join(' ') || event.time;
}
function stripDayPrefix(meta: string) { const parts=meta.split(' · '); return parts[0] && /^[A-Za-z]{3}$/.test(parts[0]) ? parts.slice(1).join(' · ') : meta; }
function attentionTone(item: AttentionItem): AttentionTone { if (item.severity==='critical') return 'error'; if (item.kind.toLowerCase().includes('hearing')) return 'blue'; return 'warning'; }
function addDays(date: Date, days: number) { const next=new Date(date); next.setDate(next.getDate()+days); return next; }
function dayHeading(date: Date) { return date.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}).toUpperCase(); }
function formatLongDate() { return new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function formatShortDate() { return new Date().toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function sourceCountKnown(state: string, count: number) { return count > 0 || state === 'ready' || state === 'empty' || state === 'all-clear' || state === 'stale'; }
function wireStaleDisclosure(model: DashboardVNextModel) { const stale=[model.xFeed.status.state==='stale'?'X cached':null,model.news.status.state==='stale'?'News cached':null].filter(Boolean); return stale.length ? ` · ${stale.join(' · ')}` : ''; }
function attentionCountBase(model: DashboardVNextModel, count: number) { const state=model.needsAttention.status.state; if(state==='loading') return 'Refreshing'; if(state==='unavailable') return 'Source unavailable'; if(state==='partial') return `${count}+ open`; return `${count} open`; }
function relativeTime(iso: string) { const ms=Date.now()-Date.parse(iso); if(!Number.isFinite(ms)) return ''; const minutes=Math.max(0,Math.floor(ms/60000)); if(minutes<60)return `${minutes}m`; const hours=Math.floor(minutes/60); if(hours<24)return `${hours}h`; return `${Math.floor(hours/24)}d`; }
function lookbackMs(lookback: NewsLookback): number {
  if (lookback === '24h') return 24 * 60 * 60 * 1000;
  if (lookback === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 48 * 60 * 60 * 1000;
}
const WIRE_WINDOW_LABEL: Record<NewsLookback, string> = {
  '24h': '24 hours', '48h': '48 hours', '7d': '7 days',
};
function relativeLabelEpoch(label: string) { const m=label.match(/(\d+)\s*(m|h|d)/i); if(!m||!m[1]||!m[2])return Date.now(); const amount=Number(m[1]); const unit=m[2].toLowerCase(); const scale=unit==='m'?60000:unit==='h'?3600000:86400000; return Date.now()-amount*scale; }
function initialsOf(value: string) { return value.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]?.toUpperCase()).join('') || '—'; }
