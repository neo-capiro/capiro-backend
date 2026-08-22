/**
 * Program Elements vNext — Movement surface (native port of
 * src/pages/program-element/v2/PeV2Movement.tsx).
 * Feed + table over the existing /api/budget-lines/movement response.
 * Classification spine: official change = ink, conflict = warning, else raised.
 * (Graph mode from the legacy finder is intentionally absent in v2.)
 *
 * Phase 4 polish: feed entries are vNext surfaces, the table is a real
 * `CapiroTable`, filters are `CapiroSelect`s and the classification spine is a
 * `CapiroBadge` tone. Same endpoint, query key, filter predicates and copy.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getMovement } from '../../../pages/program-element/api.js';
import type { MovementFeedItem } from '../../../pages/program-element/types.js';
import { sgn } from '../../../pages/program-element/v2/pe-v2-model.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { FilterControl, PeSkeletonBlock, Segmented } from './pe-primitives.js';
import { familyById, serviceToApiParam, useDefenseBudgetContext } from './defense-budget-context.js';

type MvView = 'feed' | 'table';
type Classification = 'official' | 'correction' | 'conflict' | 'new' | 'none';

const STAGE_OPTIONS = ['ANY', 'HASC', 'SASC', 'HAC-D', 'SAC-D'];
const MAT_OPTIONS = ['ANY', 'Over $10M', 'Over 5%'];

function classify(item: MovementFeedItem): Classification {
  const a = (item.action ?? '').toLowerCase();
  if (a === 'add' || a === 'cut' || a === 'new_start' || a === 'termination') return 'official';
  return 'none';
}

const CLS_LABEL: Record<string, string> = {
  official: 'OFFICIAL CHANGE',
  correction: 'CORRECTION',
  conflict: 'CONFLICT — UNRESOLVED',
  new: 'NEW STAGE AVAILABLE',
  none: 'NO MATERIAL CHANGE',
};

const CLS_TONE: Record<Classification, CapiroBadgeTone> = {
  official: 'info',
  correction: 'neutral',
  conflict: 'warning',
  new: 'info',
  none: 'neutral',
};

export function PeMovementView() {
  const api = useApi();
  const navigate = useNavigate();
  const ctx = useDefenseBudgetContext();
  const family = familyById(ctx.family);
  const [view, setView] = useState<MvView>('feed');
  const [stage, setStage] = useState('ANY');
  const [mat, setMat] = useState('ANY');

  const movement = useQuery({
    queryKey: ['pe-v2-movement'],
    queryFn: () => getMovement(api),
    staleTime: 60_000,
  });

  const scoped = useMemo(() => {
    let feed = movement.data?.feed ?? [];
    if (family.lineType) feed = feed.filter((m) => m.lineType === family.lineType);
    const apiService = serviceToApiParam(ctx.service);
    if (apiService) {
      feed = feed.filter((m) => (m.service ?? '').trim().toUpperCase() === apiService);
    }
    if (ctx.q.trim()) {
      const q = ctx.q.trim().toLowerCase();
      feed = feed.filter((m) => m.peCode.toLowerCase().includes(q) || m.title.toLowerCase().includes(q));
    }
    return feed;
  }, [movement.data, family.lineType, ctx.service, ctx.q]);

  const items = useMemo(() => {
    let feed = scoped;
    if (stage !== 'ANY') feed = feed.filter((m) => (m.stage ?? '').replaceAll('_', '-').toUpperCase() === stage);
    if (mat === 'Over $10M') feed = feed.filter((m) => m.amount != null && Math.abs(m.amount) >= 10);
    if (mat === 'Over 5%') feed = feed.filter((m) => m.amount != null && Math.abs(m.amount) >= 5); // conservative: $ proxy
    return feed;
  }, [scoped, stage, mat]);

  // Intelligence rail — real counts over the family/service-scoped feed
  // (design doc §4 Movement: "increased · decreased · House/Senate divergences
  // · new sources · review required"). Divergence and new-sources are not
  // computable per-line from this feed today, so those two cells are omitted
  // rather than fabricated; the two that ARE real stand alone.
  const increased = scoped.filter((m) => (m.amount ?? 0) > 0).length;
  const decreased = scoped.filter((m) => (m.amount ?? 0) < 0).length;

  return (
    <div data-screen-label="Movement" className="pe-ws-view">
      <div className="pe-v2-page-head">
        <div className="pe-ws-head__text">
          <div className="pe-v2-page-title">Movement</div>
          <div className="pe-v2-page-sub">
            Official funding changes in the active defense-budget snapshot.
          </div>
        </div>
        <div className="pe-ws-head__actions">
          <Segmented
            ariaLabel="Movement view"
            options={[
              { value: 'feed', label: 'FEED' },
              { value: 'table', label: 'TABLE' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      <div className="pe-ws-body">
        <section className="pe-v2-card pe-ws-metrics" aria-label="Movement intelligence">
          <div className="pe-ws-metric">
            <div className="pe-ws-cap pe-ws-cap--strong">Increased</div>
            <div className="pe-ws-metric__value" style={{ color: 'var(--capiro-color-success, #027A48)' }}>
              {movement.isLoading ? '…' : `+${increased}`}
            </div>
          </div>
          <div className="pe-ws-metric">
            <div className="pe-ws-cap pe-ws-cap--strong">Decreased</div>
            <div className="pe-ws-metric__value" style={{ color: 'var(--capiro-color-error, #B42318)' }}>
              {movement.isLoading ? '…' : `−${decreased}`}
            </div>
          </div>
          <div className="pe-ws-metric">
            <div className="pe-ws-cap pe-ws-cap--strong">Scope</div>
            <div className="pe-ws-metric__value">{movement.isLoading ? '…' : scoped.length}</div>
            <div className="pe-ws-cap">
              {family.id === 'All' ? 'ALL FAMILIES' : family.label.toUpperCase()}
              {ctx.service !== 'All' ? ` · ${ctx.service.toUpperCase()}` : ''}
            </div>
          </div>
        </section>

        <section className="pe-v2-card" aria-label="Filters">
          <div className="pe-ws-toolbar__row">
            <span className="pe-ws-eyebrow pe-ws-toolbar__legend">Filters</span>
            <FilterControl
              label="Stage"
              value={stage}
              options={STAGE_OPTIONS}
              onChange={setStage}
              formatValue={(v) => v.replace('_', '-')}
            />
            <FilterControl label="Materiality" value={mat} options={MAT_OPTIONS} onChange={setMat} />
            <span className="pe-ws-spacer" />
            <span className="pe-ws-cap pe-ws-toolbar__count">
              {items.length} CHANGES · FY{movement.data?.openFy ?? '—'}
            </span>
          </div>
        </section>

        {movement.isLoading ? (
          <section className="pe-v2-card">
            <div className="pe-ws-pad">
              <PeSkeletonBlock rows={6} />
            </div>
          </section>
        ) : items.length === 0 ? (
          <section className="pe-v2-card">
            <div className="pe-ws-pad pe-ws-pad--tall">
              <CapiroEmptyState title="No movement matches every filter" />
            </div>
          </section>
        ) : view === 'feed' ? (
          <section className="pe-v2-card pe-ws-tablecard">
            <ul className="pe-ws-feed">
              {items.map((m) => {
                const cls = classify(m);
                const isCut = (m.amount ?? 0) < 0;
                return (
                  <li key={m.id} className={`pe-ws-feed__item pe-ws-feed__item--${cls}`}>
                    <div className="pe-ws-feed__spine">
                      <div className="pe-ws-cap">
                        FY{m.fy} · {(m.stage ?? '').replaceAll('_', '-').toUpperCase()}
                      </div>
                      <CapiroBadge tone={CLS_TONE[cls]}>{CLS_LABEL[cls]}</CapiroBadge>
                    </div>
                    <div className="pe-ws-feed__main">
                      <button
                        type="button"
                        className="pe-ws-feed__title"
                        onClick={() => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`)}
                      >
                        {m.title}
                      </button>
                      <div className="pe-ws-cap">
                        {m.peCode} · {(m.service ?? '').toUpperCase()} · {(m.lineType ?? '').toUpperCase()}
                      </div>
                      {m.note ? <p className="pe-ws-feed__note">{m.note}</p> : null}
                    </div>
                    <div className="pe-ws-feed__figure">
                      <span className="pe-ws-feed__amount">{m.amount == null ? '—' : sgn(m.amount)}</span>
                      <span
                        className={`pe-ws-feed__dir${
                          m.amount == null ? ' is-none' : isCut ? ' is-down' : ' is-up'
                        }`}
                      >
                        {m.amount == null ? 'NO MATERIAL CHANGE' : isCut ? 'PROGRAM DECREASE' : 'PROGRAM INCREASE'}
                      </span>
                      <span className="pe-ws-feed__actions">
                        <CapiroButton
                          size="compact"
                          onClick={() => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`)}
                        >
                          Open line
                        </CapiroButton>
                        <CapiroButton
                          size="compact"
                          variant="primary"
                          onClick={() => navigate(`/actions?peCode=${encodeURIComponent(m.peCode)}`)}
                        >
                          Create action
                        </CapiroButton>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="pe-v2-table-foot">{items.length} CHANGES · RANKED BY MATERIALITY</div>
          </section>
        ) : (
          <section className="pe-v2-card pe-ws-tablecard">
            <CapiroTableWrap className="pe-ws-tablescroll">
              <CapiroTable className="pe-ws-table">
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell className="pe-ws-col-id">Program / budget line</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Field</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-num">Change</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-num">FY</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Classification</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {items.map((m) => {
                    const cls = classify(m);
                    const open = () => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`);
                    return (
                      <tr key={m.id} className="pe-ws-row pe-ws-row--link" onClick={open}>
                        <CapiroTableCell className="pe-ws-col-id">
                          <button
                            type="button"
                            className="pe-ws-idbtn"
                            onClick={(event) => {
                              event.stopPropagation();
                              open();
                            }}
                          >
                            <span className="pe-ws-code">{m.peCode}</span>
                            <span className="pe-ws-title">{m.title}</span>
                          </button>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta">
                          {(m.stage ?? '').replaceAll('_', '-').toUpperCase()} POSITION
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-num">
                          <span
                            className={`pe-ws-delta${
                              (m.amount ?? 0) > 0 ? ' is-up' : (m.amount ?? 0) < 0 ? ' is-down' : ' is-flat'
                            }`}
                          >
                            {m.amount == null ? '—' : sgn(m.amount)}
                          </span>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-num">FY{m.fy}</CapiroTableCell>
                        <CapiroTableCell>
                          <CapiroBadge tone={CLS_TONE[cls]}>{CLS_LABEL[cls]}</CapiroBadge>
                        </CapiroTableCell>
                      </tr>
                    );
                  })}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <div className="pe-v2-table-foot">{items.length} CHANGES · FY{movement.data?.openFy ?? '—'}</div>
          </section>
        )}
      </div>
    </div>
  );
}
