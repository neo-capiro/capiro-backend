import { useMemo, useState } from 'react';
import { Empty, Skeleton } from 'antd';
import { CaretDownOutlined, CaretUpOutlined } from '@ant-design/icons';
import { Sparkline, fmtMoneyM } from './charts/index.js';
import { BaBadge, PeCodeBadge, ServiceCell, SignalPill, WatchStar } from './pe-shared.js';
import type { ProgramElementListItem } from './types.js';

type SortKey = 'peCode' | 'service' | 'latestRequest' | 'latestEnacted' | 'deltaPct' | 'billCount';
interface SortState {
  key: SortKey | null;
  dir: 'asc' | 'desc';
}

interface Props {
  rows: ProgramElementListItem[];
  loading: boolean;
  onOpen: (peCode: string) => void;
  onToggleWatch: (row: ProgramElementListItem) => void;
  watchBusyCode?: string | null;
}

function compare(a: ProgramElementListItem, b: ProgramElementListItem, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  // Nulls always sort last (independent of direction).
  const an = av == null;
  const bn = bv == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv);
  return (av as number) - (bv as number);
}

function MoneyCell({ value, fy }: { value: number | null | undefined; fy: number | null | undefined }) {
  if (value == null) return <span className="pe-dash">—</span>;
  return (
    <span className="pe-money-cell">
      <span className="pe-money-v">{fmtMoneyM(value)}</span>
      {fy ? <span className="pe-money-fy">FY{String(fy).slice(-2)}</span> : null}
    </span>
  );
}

const HEADERS: Array<{
  key: SortKey | null;
  label: string;
  align?: 'r' | 'c';
}> = [
  { key: 'peCode', label: 'Program element' },
  { key: 'service', label: 'Service', align: 'c' },
  { key: null, label: 'BA', align: 'c' },
  { key: 'latestRequest', label: 'Request', align: 'r' },
  { key: 'latestEnacted', label: 'Enacted', align: 'r' },
  { key: 'deltaPct', label: 'Δ vs req', align: 'r' },
  { key: null, label: '6-yr trend', align: 'c' },
  { key: 'billCount', label: 'Bills', align: 'c' },
  { key: null, label: 'Signal', align: 'c' },
  { key: null, label: '', align: 'c' },
];

export function FinderCatalogTable({ rows, loading, onOpen, onToggleWatch, watchBusyCode }: Props) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'desc' });

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = sort.key;
    return [...rows].sort((a, b) => {
      const base = compare(a, b, key);
      // Keep null-last stable regardless of dir: only flip the sign for real values.
      const aNull = a[key] == null;
      const bNull = b[key] == null;
      if (aNull || bNull) return base;
      return base * dir;
    });
  }, [rows, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: 'desc' },
    );

  return (
    <div className="pe-idx-table" role="table" aria-label="Program elements">
      <div className="pe-idx-tr pe-idx-thead" role="row">
        {HEADERS.map((h, i) =>
          h.key ? (
            <button
              key={i}
              type="button"
              className={`pe-th${h.align ? ` ${h.align}` : ''}`}
              onClick={() => toggleSort(h.key as SortKey)}
              role="columnheader"
              aria-sort={sort.key === h.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              {h.label}
              {sort.key === h.key ? (
                <span className="pe-sort-arrow">
                  {sort.dir === 'desc' ? <CaretDownOutlined /> : <CaretUpOutlined />}
                </span>
              ) : null}
            </button>
          ) : (
            <div key={i} className={`pe-th${h.align ? ` ${h.align}` : ''}`} role="columnheader">
              {h.label}
            </div>
          ),
        )}
      </div>

      {loading ? (
        [0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="pe-idx-tr pe-idx-row" role="row">
            <div className="pe-td" style={{ gridColumn: '1 / -1' }}>
              <Skeleton active paragraph={false} title={{ width: '100%' }} />
            </div>
          </div>
        ))
      ) : sorted.length === 0 ? (
        <div className="pe-idx-empty">
          <Empty description="No program elements matched your search" />
        </div>
      ) : (
        sorted.map((pe) => {
          const trendUp =
            pe.spark && pe.spark.length > 1
              ? pe.spark[pe.spark.length - 1]! >= pe.spark[0]!
              : true;
          return (
            <div
              key={pe.peCode}
              className="pe-idx-tr pe-idx-row"
              role="row"
              tabIndex={0}
              onClick={() => onOpen(pe.peCode)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(pe.peCode);
                }
              }}
            >
              <div className="pe-td pe-idx-name" role="cell">
                <PeCodeBadge code={pe.peCode} />
                <span className="pe-idx-name-t" title={pe.title}>
                  {pe.title}
                </span>
              </div>
              <div className="pe-td c" role="cell">
                <ServiceCell service={pe.service} />
              </div>
              <div className="pe-td c" role="cell">
                <BaBadge budgetActivity={pe.budgetActivity} />
              </div>
              <div className="pe-td r" role="cell">
                <MoneyCell value={pe.latestRequest} fy={pe.latestRequestFy} />
              </div>
              <div className="pe-td r pe-strong" role="cell">
                <MoneyCell value={pe.latestEnacted} fy={pe.latestEnactedFy} />
              </div>
              <div
                className={`pe-td r pe-num ${pe.deltaPct == null ? '' : pe.deltaPct >= 0 ? 'pe-up' : 'pe-down'}`}
                role="cell"
              >
                {pe.deltaPct == null
                  ? '—'
                  : `${pe.deltaPct >= 0 ? '+' : ''}${pe.deltaPct.toFixed(1)}%`}
              </div>
              <div className="pe-td c pe-spark-cell" role="cell">
                {pe.spark && pe.spark.length > 1 ? (
                  <Sparkline
                    data={pe.spark}
                    width={80}
                    height={24}
                    color={trendUp ? 'var(--accent)' : 'var(--critical)'}
                  />
                ) : (
                  <span className="pe-dash">—</span>
                )}
              </div>
              <div className="pe-td c pe-num" role="cell">
                {pe.billCount ?? '—'}
              </div>
              <div className="pe-td c" role="cell">
                <SignalPill item={pe} />
              </div>
              <div className="pe-td c" role="cell">
                <WatchStar
                  watched={Boolean(pe.watched)}
                  busy={watchBusyCode === pe.peCode}
                  onToggle={() => onToggleWatch(pe)}
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
