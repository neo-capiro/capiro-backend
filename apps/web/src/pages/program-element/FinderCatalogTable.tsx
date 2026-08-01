import { useMemo, useState } from 'react';
import { Empty, Skeleton } from 'antd';
import { CaretDownOutlined, CaretUpOutlined } from '@ant-design/icons';
import { fmtMoneyM } from './charts/index.js';
import {
  ActionSignalChip,
  PeCodeBadge,
  ServiceCell,
  SignalPill,
} from './pe-shared.js';
import type { ProgramElementListItem } from './types.js';
import { STAGE_LABEL, type FundingStage } from './funding-model.js';

type SortKey = 'peCode' | 'title' | 'service' | 'latestCurrent' | 'deltaPct' | 'billCount';

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
  const aNull = av == null;
  const bNull = bv == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv);
  return Number(av) - Number(bv);
}

function MoneyCell({ row }: { row: ProgramElementListItem }) {
  if (row.latestCurrent == null) return <span className="pe-rd-dash">—</span>;
  const stageLabel =
    row.latestCurrentStage && row.latestCurrentStage !== 'none'
      ? STAGE_LABEL[row.latestCurrentStage as FundingStage] ?? row.latestCurrentStage
      : null;
  const fy = row.latestCurrentFy ? `FY${String(row.latestCurrentFy).slice(-2)}` : null;
  return (
    <span
      className="pe-rd-money"
      title={[fy, stageLabel].filter(Boolean).join(' · ') || undefined}
    >
      {fmtMoneyM(row.latestCurrent)}
    </span>
  );
}

const HEADERS: Array<{ key: SortKey | null; label: string; align?: 'right' }> = [
  { key: 'peCode', label: 'Code' },
  { key: 'title', label: 'Title' },
  { key: 'service', label: 'Service' },
  { key: 'latestCurrent', label: 'Current', align: 'right' },
  { key: 'deltaPct', label: 'Δ vs req', align: 'right' },
  { key: 'billCount', label: 'Bills', align: 'right' },
  { key: null, label: 'Signal' },
  { key: null, label: 'Monitor', align: 'right' },
];

function displayDeltaPct(row: ProgramElementListItem): number | null {
  if (
    row.latestCurrent != null &&
    row.latestRequest != null &&
    row.latestCurrentFy != null &&
    row.latestCurrentFy === row.latestRequestFy &&
    row.latestRequest !== 0
  ) {
    return ((row.latestCurrent - row.latestRequest) / Math.abs(row.latestRequest)) * 100;
  }
  return row.deltaPct ?? null;
}

function rowTone(row: ProgramElementListItem): string {
  const tone = row.actionSignalTone;
  if (tone === 'critical') return 'is-critical';
  if (tone === 'notable') return 'is-notable';
  if (tone === 'info') return 'is-info';
  const delta = displayDeltaPct(row);
  if ((delta ?? 0) < 0) return 'is-critical';
  if ((delta ?? 0) > 0) return 'is-positive';
  return '';
}

export function FinderCatalogTable({
  rows,
  loading,
  onOpen,
  onToggleWatch,
  watchBusyCode,
}: Props) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'desc' });

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const direction = sort.dir === 'asc' ? 1 : -1;
    const key = sort.key;
    return [...rows].sort((left, right) => {
      const base = compare(left, right, key);
      if (left[key] == null || right[key] == null) return base;
      return base * direction;
    });
  }, [rows, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((previous) =>
      previous.key === key
        ? { key, dir: previous.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: 'desc' },
    );

  return (
    <div className="pe-rd-table-scroll">
      <div className="pe-rd-table" role="table" aria-label="Program elements">
        <div className="pe-rd-table-row pe-rd-table-head" role="row">
          {HEADERS.map((header, index) =>
            header.key ? (
              <button
                key={header.key}
                type="button"
                className={header.align === 'right' ? 'is-right' : ''}
                onClick={() => toggleSort(header.key as SortKey)}
                role="columnheader"
                aria-sort={
                  sort.key === header.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {header.label}
                {sort.key === header.key ? (
                  sort.dir === 'desc' ? (
                    <CaretDownOutlined />
                  ) : (
                    <CaretUpOutlined />
                  )
                ) : null}
              </button>
            ) : (
              <span
                key={`${header.label}-${index}`}
                className={header.align === 'right' ? 'is-right' : ''}
                role="columnheader"
              >
                {header.label}
              </span>
            ),
          )}
        </div>

        {loading ? (
          [0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="pe-rd-table-row pe-rd-table-data" role="row">
              <div className="pe-rd-table-skeleton">
                <Skeleton active paragraph={false} title={{ width: '100%' }} />
              </div>
            </div>
          ))
        ) : sorted.length === 0 ? (
          <div className="pe-rd-table-empty">
            <Empty description="No budget lines match this search." />
          </div>
        ) : (
          sorted.map((row) => {
            const delta = displayDeltaPct(row);
            const busy = watchBusyCode === row.peCode;
            return (
              <div
                key={row.peCode}
                className={`pe-rd-table-row pe-rd-table-data ${rowTone(row)}`}
                role="row"
                tabIndex={0}
                onClick={() => onOpen(row.peCode)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(row.peCode);
                  }
                }}
              >
                <div role="cell">
                  <PeCodeBadge code={row.peCode} />
                </div>
                <div className="pe-rd-table-title" role="cell" title={row.title}>
                  {row.title}
                </div>
                <div role="cell">
                  <ServiceCell service={row.service} />
                </div>
                <div className="is-right" role="cell">
                  <MoneyCell row={row} />
                </div>
                <div
                  className={`pe-rd-delta is-right${
                    delta == null ? '' : delta < 0 ? ' is-down' : delta > 0 ? ' is-up' : ''
                  }`}
                  role="cell"
                >
                  {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
                </div>
                <div className="pe-rd-bills is-right" role="cell">
                  {row.billCount ?? '—'}
                </div>
                <div className="pe-rd-signal-cell" role="cell">
                  {row.actionSignalType ? (
                    <ActionSignalChip type={row.actionSignalType} tone={row.actionSignalTone} />
                  ) : (
                    <SignalPill item={row} />
                  )}
                </div>
                <div className="is-right" role="cell">
                  <button
                    type="button"
                    className={`pe-rd-monitor-btn${row.watched ? ' is-on' : ''}`}
                    aria-pressed={Boolean(row.watched)}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleWatch(row);
                    }}
                  >
                    {row.watched ? 'Monitoring' : 'Monitor'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
