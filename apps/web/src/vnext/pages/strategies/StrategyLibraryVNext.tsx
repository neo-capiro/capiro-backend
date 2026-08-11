import { useMemo, useState, type CSSProperties } from 'react';
import { App as AntApp } from 'antd';
import {
  CalendarOutlined,
  DatabaseOutlined,
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import {
  useFirmPhases,
  usePendingWatchCounts,
  useStrategies,
} from '../../../pages/strategy/api.js';
import { useClientsLite, clientColor } from '../../../pages/strategy/clients-lite.js';
import { useTenantMembers, memberName, initialsOf } from '../../../pages/strategy/members.js';
import {
  FIRM_PHASES_DEFAULT,
  STRATEGY_TYPE_LABEL,
  relativeTime,
} from '../../../pages/strategy/constants.js';
import { buildCalendar } from '../../../pages/strategy/fiscal.js';
import { GoalModal } from '../../../pages/strategy/GoalModal.js';
import { FirmConfig } from '../../../pages/strategy/FirmConfig.js';
import { canShowWatchRail } from '../../../pages/strategy/agents/agent-utils.js';
import type { StrategyListItem } from '../../../pages/strategy/types.js';

type SortMode = 'recent' | 'client';

/**
 * Figma source: Strategies / 01 Library — 843:2502.
 * All numbers, client rows, owners and watch-state chips below are calculated
 * from the existing production Strategy APIs; the Figma mock's sample content
 * is never shipped as product data.
 */
export function StrategyLibraryVNext() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const strategies = useStrategies();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const me = useMe();
  const meriEnabled = Boolean(me.data?.features.strategyPlannerMeri);
  const agentic = Boolean(me.data?.features.agenticMeri);
  const watcherEnabled = canShowWatchRail(me.data?.features);
  const pendingCounts = usePendingWatchCounts(watcherEnabled);
  const calendar = useMemo(() => buildCalendar(new Date()), []);

  const [goalOpen, setGoalOpen] = useState(false);
  const [firmOpen, setFirmOpen] = useState(false);
  const [clientFilter, setClientFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [sort, setSort] = useState<SortMode>('recent');

  const clientName = (id: string) => clients.data?.find((c) => c.id === id)?.name ?? 'Client';
  const ownerLabel = (ownerUserId: string) => memberName(members.data, ownerUserId);
  const ownerInitials = (ownerUserId: string) => initialsOf(memberName(members.data, ownerUserId));

  const allRows = strategies.data ?? [];
  const rows = useMemo(() => {
    const filtered = allRows.filter(
      (strategy) =>
        (clientFilter === 'all' || strategy.clientId === clientFilter) &&
        (ownerFilter === 'all' || strategy.ownerUserId === ownerFilter),
    );
    return [...filtered].sort((left, right) => {
      if (sort === 'client') return clientName(left.clientId).localeCompare(clientName(right.clientId));
      return (
        new Date(right.lastEditedAt ?? right.createdAt).getTime() -
        new Date(left.lastEditedAt ?? left.createdAt).getTime()
      );
    });
    // clientName is intentionally resolved from the client query for A–Z sorting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, clients.data, clientFilter, ownerFilter, sort]);

  const clientOptions = useMemo(() => [...new Set(allRows.map((row) => row.clientId))], [allRows]);
  const ownerOptions = useMemo(() => [...new Set(allRows.map((row) => row.ownerUserId))], [allRows]);

  const firmLoaded = firmPhases.isSuccess;
  const firmConfigured = (firmPhases.data?.length ?? 0) > 0;
  const metrics = useMemo(() => {
    const portfolioClients = new Set(allRows.map((row) => row.clientId)).size;
    const needsReview = allRows.filter((row) => (pendingCounts.data?.[row.id] ?? 0) > 0).length;
    const totalSteps = allRows.reduce((sum, row) => sum + row.nodeCount, 0);
    const owned = allRows.filter((row) => Boolean(row.ownerUserId)).length;
    return {
      portfolioClients,
      needsReview,
      totalSteps,
      ownerCoverage: allRows.length ? Math.round((owned / allRows.length) * 100) : 0,
    };
  }, [allRows, pendingCounts.data]);

  return (
    <div className="vnext-strategy-library" data-figma-node="843:2502">
      <header className="vnext-strategy-library__header">
        <div>
          <div className="vnext-strategy-eyebrow">Strategy operating system</div>
          <h1>Strategies</h1>
          <p>
            Turn client goals into executable plans aligned to appropriations, authorization,
            regulatory and procurement calendars.
          </p>
        </div>
        <div className="vnext-strategy-library__actions">
          {agentic ? (
            <>
              <button className="vnext-strategy-button" onClick={() => navigate('/strategies/agents/review')}>
                <RobotOutlined /> Agent review
              </button>
              <button className="vnext-strategy-button" onClick={() => navigate('/strategies/context')}>
                <DatabaseOutlined /> Context library
              </button>
            </>
          ) : null}
          <button className="vnext-strategy-button is-primary" onClick={() => setGoalOpen(true)}>
            <PlusOutlined /> New strategy
          </button>
        </div>
      </header>

      <div className="vnext-strategy-library__body">
        {!firmLoaded ? (
          <FirmPhaseStrip icon={<CalendarOutlined />} title="Loading firm phases…" detail="Aligning this library to your operating calendar." />
        ) : firmConfigured ? (
          <FirmPhaseStrip
            icon={<CalendarOutlined />}
            title="Firm phases are set"
            detail={`${firmPhases.data?.length ?? 0} operating phases align every strategy to the firm’s planning rhythm.`}
            action={<button className="vnext-strategy-button" onClick={() => setFirmOpen(true)}><SettingOutlined /> Edit phases</button>}
          />
        ) : (
          <FirmPhaseStrip
            icon={<CalendarOutlined />}
            title="Set your firm phases"
            detail={`Start from the ${FIRM_PHASES_DEFAULT.length}-phase template, then adapt it to your firm.`}
            action={<button className="vnext-strategy-button is-primary" onClick={() => setFirmOpen(true)}>Set firm phases</button>}
          />
        )}

        <section className="vnext-strategy-metrics" aria-label="Strategy portfolio summary">
          <Metric value={String(allRows.length)} label="Active strategies" sub={`Across ${metrics.portfolioClients} client${metrics.portfolioClients === 1 ? '' : 's'}`} tone="accent" />
          <Metric value={String(metrics.needsReview)} label="Needs review" sub="Watcher proposals" tone="warning" />
          <Metric value={String(metrics.totalSteps)} label="Plan steps" sub="Across active plans" tone="danger" />
          <Metric value={`${metrics.ownerCoverage}%`} label="Owner coverage" sub="Plans with owners" tone="success" />
        </section>

        <section className="vnext-strategy-list" aria-labelledby="vnext-strategy-list-title">
          <div className="vnext-strategy-list__toolbar">
            <div className="vnext-strategy-list__copy">
              <div id="vnext-strategy-list-title" className="vnext-strategy-section-label">Your strategies</div>
              <div className="vnext-strategy-list__summary">
                {rows.length} plan{rows.length === 1 ? '' : 's'} · {metrics.needsReview} need attention
              </div>
            </div>
            <select aria-label="Filter strategies by client" value={clientFilter} onChange={(event) => setClientFilter(event.target.value)}>
              <option value="all">All clients</option>
              {clientOptions.map((id) => <option key={id} value={id}>{clientName(id)}</option>)}
            </select>
            <select aria-label="Filter strategies by owner" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="all">All owners</option>
              {ownerOptions.map((id) => <option key={id} value={id}>{ownerLabel(id)}</option>)}
            </select>
            <select aria-label="Sort strategies" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
              <option value="recent">Recently updated</option>
              <option value="client">Client A–Z</option>
            </select>
          </div>

          <div className="vnext-strategy-table">
            <div className="vnext-strategy-table__head" aria-hidden="true">
              <span>Client / Strategy</span>
              <span>Plan</span>
              <span>Owner</span>
              <span>Updated</span>
              <span />
            </div>
            {strategies.isLoading ? (
              <div className="vnext-strategy-empty">Loading strategies…</div>
            ) : rows.length === 0 ? (
              <div className="vnext-strategy-empty">
                {allRows.length ? 'No strategies match these filters.' : 'No strategies yet — create your first with “New strategy”.'}
              </div>
            ) : (
              rows.map((strategy) => (
                <StrategyRow
                  key={strategy.id}
                  strategy={strategy}
                  clientName={clientName(strategy.clientId)}
                  ownerName={ownerLabel(strategy.ownerUserId)}
                  ownerInitials={ownerInitials(strategy.ownerUserId)}
                  pendingWatchCount={pendingCounts.data?.[strategy.id] ?? 0}
                  onOpen={() => navigate(`/strategies/${strategy.id}`)}
                />
              ))
            )}
          </div>
        </section>
      </div>

      {goalOpen ? (
        <GoalModal
          clients={clients.data ?? []}
          meriEnabled={meriEnabled}
          firmConfigured={!firmLoaded || firmConfigured}
          onConfigureFirm={() => {
            setGoalOpen(false);
            setFirmOpen(true);
          }}
          onClose={() => setGoalOpen(false)}
          onCreated={(id) => {
            setGoalOpen(false);
            navigate(`/strategies/${id}`);
          }}
        />
      ) : null}

      {firmOpen ? (
        <FirmConfig
          firstRun={firmLoaded && !firmConfigured}
          phases={firmPhases.data ?? []}
          calendar={calendar}
          onClose={() => setFirmOpen(false)}
          onSaved={(text) => message.success(text)}
        />
      ) : null}
    </div>
  );
}

function FirmPhaseStrip({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="vnext-strategy-firm-strip">
      <span className="vnext-strategy-firm-strip__icon" aria-hidden="true">{icon}</span>
      <div className="vnext-strategy-firm-strip__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action ? <div className="vnext-strategy-firm-strip__action">{action}</div> : null}
    </section>
  );
}

function Metric({
  value,
  label,
  sub,
  tone,
}: {
  value: string;
  label: string;
  sub: string;
  tone: 'accent' | 'warning' | 'danger' | 'success';
}) {
  return (
    <article className={`vnext-strategy-metric tone-${tone}`}>
      <div className="vnext-strategy-metric__value">{value}</div>
      <div>
        <div className="vnext-strategy-metric__label">{label}</div>
        <div className="vnext-strategy-metric__sub">{sub}</div>
      </div>
    </article>
  );
}

function StrategyRow({
  strategy,
  clientName,
  ownerName,
  ownerInitials,
  pendingWatchCount,
  onOpen,
}: {
  strategy: StrategyListItem;
  clientName: string;
  ownerName: string;
  ownerInitials: string;
  pendingWatchCount: number;
  onOpen: () => void;
}) {
  const style = { '--strategy-client-rail': clientColor(strategy.clientId) } as CSSProperties;
  return (
    <button type="button" className="vnext-strategy-row" style={style} onClick={onOpen}>
      <div className="vnext-strategy-row__main">
        <span className="vnext-strategy-row__client">{clientName}</span>
        <span className="vnext-strategy-row__title">{strategy.title}</span>
      </div>
      <div>
        <span className="vnext-strategy-row__type">{STRATEGY_TYPE_LABEL[strategy.type]}</span>
        <span className="vnext-strategy-row__steps">{strategy.nodeCount} step{strategy.nodeCount === 1 ? '' : 's'}</span>
      </div>
      <div className="vnext-strategy-row__owner">
        <span className="vnext-strategy-row__avatar">{ownerInitials}</span>
        <span className="vnext-strategy-row__owner-copy">
          <span>{ownerName}</span>
          {pendingWatchCount ? (
            <span className="vnext-strategy-chip is-warning">{pendingWatchCount} watch note{pendingWatchCount === 1 ? '' : 's'}</span>
          ) : (
            <span className="vnext-strategy-chip is-success">On track</span>
          )}
        </span>
      </div>
      <span className="vnext-strategy-row__updated">{relativeTime(strategy.lastEditedAt ?? strategy.createdAt)}</span>
      <span className="vnext-strategy-row__chevron" aria-hidden="true">›</span>
    </button>
  );
}
