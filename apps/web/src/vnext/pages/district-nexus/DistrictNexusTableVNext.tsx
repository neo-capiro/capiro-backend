import { useMemo, useState } from 'react';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroTooltip } from '../../components/menus/index.js';
import type { DistrictNexusDistrictSummary } from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import { bandOf, formatMoney, formatNumber } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import { DnxWarningIcon } from './icons.js';

interface Props {
  districts: DistrictNexusDistrictSummary[];
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
  /** Compact variant is used in the rail and as the map's failure fallback
   * (§8.6); the standalone variant gets more breathing room. Both share every
   * column and every honest-state rule below. */
  compact?: boolean;
}

type SortKey = 'score' | 'coveragePercent' | 'contracts' | 'grants';
interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const SORT_VALUE: Record<SortKey, (d: DistrictNexusDistrictSummary) => number> = {
  // Nulls sort below every real value in ascending order — mirrors the
  // canonical antd sorters' `?? -1` convention.
  score: (d) => d.score ?? -1,
  coveragePercent: (d) => d.coveragePercent,
  contracts: (d) => d.awarded.contractObligations ?? -1,
  grants: (d) => d.awarded.grantObligations ?? -1,
};

/**
 * vNext port of the canonical DistrictNexusTable (WS-G Step G5) — a
 * first-class alternative to the map, not an afterthought: every district the
 * map could show is reachable here by keyboard, and this is what replaces the
 * map entirely when the boundary artifact or WebGL is unavailable (§8.6).
 *
 * Deliberately has NO "Representative" column: DistrictNexusDistrictSummary
 * (the map-aggregate row) does not carry representation — that only exists on
 * the per-district detail response, and fetching it for every row here would
 * be exactly the N+1 the aggregation service's docblock forbids. Open a row
 * to see representatives in the drawer.
 */
export function DistrictNexusTableVNext({ districts, selectedDistrictKey, onSelectDistrict, compact }: Props) {
  const [sort, setSort] = useState<SortState | null>(null);

  const rows = useMemo(() => {
    if (!sort) return districts;
    const pick = SORT_VALUE[sort.key];
    const sign = sort.direction === 'asc' ? 1 : -1;
    return [...districts].sort((a, b) => sign * (pick(a) - pick(b)));
  }, [districts, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };

  const sortableHeader = (key: SortKey, label: string, align?: 'right') => {
    const active = sort?.key === key;
    return (
      <CapiroTableHeaderCell
        aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={align === 'right' ? 'dnx-right' : undefined}
      >
        <button type="button" className="dnx-sort" onClick={() => toggleSort(key)}>
          {label}
          <span className="dnx-sort-dir" aria-hidden="true">
            {active ? (sort!.direction === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
      </CapiroTableHeaderCell>
    );
  };

  return (
    <CapiroTableWrap className={`dnx-tablewrap${compact ? ' dnx-tablewrap-compact' : ''}`}>
      <CapiroTable className="dnx-table">
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>District</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Name</CapiroTableHeaderCell>
            {sortableHeader('score', 'Nexus')}
            {sortableHeader('coveragePercent', 'Coverage', 'right')}
            {sortableHeader('contracts', 'Contracts', 'right')}
            {sortableHeader('grants', 'Grants', 'right')}
            <CapiroTableHeaderCell className="dnx-right">Employees</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Clients</CapiroTableHeaderCell>
            <CapiroTableHeaderCell aria-label="Data quality" />
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {rows.length === 0 ? (
            <tr>
              <CapiroTableCell colSpan={9} className="dnx-empty-cell">
                No districts match these filters. Nothing was hidden by an error — the filter set simply has no results.
              </CapiroTableCell>
            </tr>
          ) : (
            rows.map((record) => {
              const band = bandOf(record.score);
              return (
                <tr
                  key={record.districtKey}
                  className={record.districtKey === selectedDistrictKey ? 'dnx-row-selected' : undefined}
                  onClick={() => onSelectDistrict(record.districtKey)}
                  aria-selected={record.districtKey === selectedDistrictKey}
                  style={{ cursor: 'pointer' }}
                >
                  <CapiroTableCell>
                    <button
                      type="button"
                      className="dnx-row-btn"
                      aria-label={`Select district ${record.districtKey}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectDistrict(record.districtKey);
                      }}
                    >
                      <span className="dnx-num" style={{ fontWeight: 700 }}>
                        {record.districtKey}
                      </span>
                      {record.status === 'F' ? <CapiroBadge tone="info">future</CapiroBadge> : null}
                    </button>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-ellipsis">
                    {record.name ?? <span className="dnx-muted">—</span>}
                  </CapiroTableCell>
                  <CapiroTableCell>
                    {band ? (
                      <span style={{ color: band.color, fontWeight: 700 }}>
                        {band.label} <span className="dnx-num">{record.score}</span>
                      </span>
                    ) : (
                      <span className="dnx-muted">Unscored</span>
                    )}
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-right">
                    <span className="dnx-num">{record.coveragePercent}%</span>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-right">
                    <span className="dnx-num">{formatMoney(record.awarded.contractObligations)}</span>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-right">
                    <span className="dnx-num">{formatMoney(record.awarded.grantObligations)}</span>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-right">
                    <span className="dnx-num">
                      {record.employeeCount != null
                        ? formatNumber(record.employeeCount)
                        : record.employeesUnreported
                          ? 'n/r'
                          : '—'}
                    </span>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-right">
                    <span className="dnx-num">{record.clientCount}</span>
                  </CapiroTableCell>
                  <CapiroTableCell className="dnx-warncell">
                    {record.warnings.length ? (
                      <CapiroTooltip content={record.warnings.map((w) => w.message).join(' ')}>
                        <DnxWarningIcon className="dnx-warn-ico" />
                      </CapiroTooltip>
                    ) : null}
                  </CapiroTableCell>
                </tr>
              );
            })
          )}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}
