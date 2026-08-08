/**
 * Funding Opportunities v2 — Explore: the raw source catalog table.
 *
 * The mockup's Explore tab: a sticky-header table (SOURCE ID / TITLE / AGENCY /
 * NOTICE TYPE / CLOSES / CEILING / EVIDENCE) over the unscoped catalog, with the
 * search box, the source-unreachable banner, and the freshness footer.
 *
 * The mockup's RETRY SWEEP button is OMITTED: there is no backend endpoint that
 * re-triggers a source sweep, and the v2 rule is to never fake an interactive
 * affordance. The banner still TELLS the reader a rail is stale.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import { readInt, useUrlState } from '../funding-opportunities-url-state.js';
import {
  KIND_LABELS,
  moneyLine,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type OpportunityRef,
  type OpportunitySourceFreshness,
} from '../funding-opportunities-api.js';
import { evidenceMark } from './fo-v2-model.js';

export function FoV2Explore({
  clientId,
  source,
  freshness,
  onOpen,
  compact,
}: {
  clientId: string | undefined;
  source: string;
  freshness: OpportunitySourceFreshness[];
  onOpen: (ref: OpportunityRef) => void;
  compact: boolean;
}) {
  const api = useApi();
  const url = useUrlState();
  const search = url.get('q') ?? '';
  const page = readInt(url.get('page'), 1, 100_000) ?? 1;

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (clientId) params.set('clientId', clientId);
    if (source === 'grants_gov' || source === 'sam_gov') params.set('source', source);
    params.set('activeState', 'active');
    if (search.trim()) params.set('q', search.trim());
    params.set('page', String(page));
    params.set('pageSize', '25');
    return params.toString();
  }, [clientId, source, search, page]);

  const list = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities', query],
    queryFn: async () =>
      (await api.get<FundingOpportunityListResponse>(`/api/intelligence/opportunities?${query}`))
        .data,
    retry: 1,
    staleTime: 30_000,
  });

  const rows = list.data?.opportunities ?? [];
  const total = list.data?.total;
  const pageSize = list.data?.pageSize ?? 25;
  const showingFrom = rows.length ? (page - 1) * pageSize + 1 : 0;
  const showingTo = rows.length ? showingFrom + rows.length - 1 : 0;

  const staleRail = freshness.find((f) => f.lastRunStatus === 'error');

  return (
    <>
      {/* Search + catalog note */}
      <div className="fo-v2-catalog-bar">
        <div className="fo-v2-catalog-search">
          <span aria-hidden style={{ fontSize: 12 }}>
            ⌕
          </span>
          <input
            aria-label="Search source records"
            placeholder={`Search ${total != null ? total.toLocaleString() : ''} active source records`}
            value={search}
            onChange={(e) => url.set({ q: e.target.value || null, page: null })}
          />
        </div>
        <div style={{ flex: 1 }} />
        <span
          className="fo-v2-mono"
          style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--fov2-secondary)' }}
        >
          CATALOG · NO CLIENT CONTEXT APPLIED
        </span>
      </div>

      {/* Source-unreachable banner (no RETRY SWEEP — no backend) */}
      {staleRail ? (
        <div className="fo-v2-alert-bar" role="status" data-testid="fo-v2-stale-banner">
          <span
            className="fo-v2-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.06em',
              color: 'var(--fov2-info-ink)',
              flex: 'none',
            }}
          >
            ⚡ SOURCE UNREACHABLE
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--fov2-body)' }}>
            {staleRail.label} last attempt failed
            {staleRail.lastAttemptAt ? ` on ${staleRail.lastAttemptAt.slice(0, 10)}` : ''}. Rows
            below keep their last successful values and their age — nothing has been re-read.
          </span>
          <div style={{ flex: 1, minWidth: 8 }} />
        </div>
      ) : null}

      {/* Table */}
      <div className="fo-v2-queue" style={{ background: 'var(--fov2-surface)' }}>
        {list.isPending ? (
          <div style={{ padding: 24 }}>
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        ) : !rows.length ? (
          <div className="fo-v2-empty-wrap">
            <div className="fo-v2-empty">
              <div className="fo-v2-empty-tag">⊘ NO RESULTS</div>
              <div className="fo-v2-empty-title">No source records match</div>
              <div className="fo-v2-empty-body">
                {list.data?.emptyExplanation ??
                  'No active source record matches the current filters. Clearing the search restores the full catalog.'}
              </div>
            </div>
          </div>
        ) : (
          <div className="fo-v2-table">
            <div className="fo-v2-thead">
              <div className="fo-v2-th">SOURCE ID</div>
              <div className="fo-v2-th">TITLE</div>
              <div className="fo-v2-th">AGENCY</div>
              <div className="fo-v2-th">NOTICE TYPE</div>
              <div className="fo-v2-th">CLOSES</div>
              <div className="fo-v2-th" style={{ textAlign: 'right' }}>
                CEILING
              </div>
              <div className="fo-v2-th">EVIDENCE</div>
            </div>
            {rows.map((o) => (
              <ExploreRow key={o.id} o={o} compact={compact} onOpen={onOpen} clientId={clientId} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="fo-v2-catalog-foot">
        <span
          className="fo-v2-mono"
          style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--fov2-secondary)' }}
        >
          SHOWING {showingFrom}–{showingTo} OF {total != null ? total.toLocaleString() : '—'}
        </span>
        <div style={{ flex: 1 }} />
        <span
          className="fo-v2-mono"
          style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--fov2-secondary)' }}
        >
          {freshness
            .map((f) => {
              const state =
                f.lastRunStatus === 'error' ? 'STALE' : f.neverSynced ? 'NEVER SYNCED' : 'FRESH';
              return `${f.label.toUpperCase()} ${state}`;
            })
            .join(' · ')}
        </span>
      </div>
    </>
  );
}

function ExploreRow({
  o,
  compact,
  onOpen,
  clientId,
}: {
  o: FundingOpportunity;
  compact: boolean;
  onOpen: (ref: OpportunityRef) => void;
  clientId: string | undefined;
}) {
  const money = moneyLine(o);
  const ev = evidenceMark(o);
  const closes = o.responseDeadline ? o.responseDeadline.slice(0, 10).toUpperCase() : '—';
  return (
    <div
      className="fo-v2-trow"
      data-testid={`fo-v2-explore-${o.id}`}
      onClick={() =>
        onOpen({ source: o.source, sourceRecordId: o.sourceRecordId, clientId: clientId ?? null })
      }
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter')
          onOpen({
            source: o.source,
            sourceRecordId: o.sourceRecordId,
            clientId: clientId ?? null,
          });
      }}
    >
      <div
        className={`fo-v2-td fo-v2-td-mono`}
        style={compact ? { padding: '7px 14px' } : undefined}
      >
        {o.sourceReference ?? o.sourceRecordId}
      </div>
      <div
        className={`fo-v2-td fo-v2-td-title`}
        style={compact ? { padding: '7px 14px' } : undefined}
      >
        {o.title}
      </div>
      <div className="fo-v2-td" style={compact ? { padding: '7px 14px' } : undefined}>
        {o.agency ?? '—'}
      </div>
      <div className="fo-v2-td fo-v2-td-mono" style={compact ? { padding: '7px 14px' } : undefined}>
        {KIND_LABELS[o.kind].toUpperCase()}
      </div>
      <div className="fo-v2-td fo-v2-td-mono" style={compact ? { padding: '7px 14px' } : undefined}>
        {closes}
      </div>
      <div className="fo-v2-td fo-v2-td-num" style={compact ? { padding: '7px 14px' } : undefined}>
        {money.value}
      </div>
      <div
        className="fo-v2-td fo-v2-td-ev"
        style={{
          color:
            ev.cls === 'ok'
              ? 'var(--fov2-ink)'
              : ev.cls === 'warn'
                ? 'var(--fov2-info-ink)'
                : 'var(--fov2-body)',
          ...(compact ? { padding: '7px 14px' } : {}),
        }}
      >
        {ev.text}
      </div>
    </div>
  );
}
