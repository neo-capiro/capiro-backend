/**
 * Program Elements vNext — Mark-up monitor (native rebuild of
 * src/pages/program-element/MarkupMonitorPage.tsx, which is antd throughout).
 *
 * Behavior contract preserved verbatim: same query key
 * (['program-element-markup-monitor', service, threshold]), same
 * mode=markup-monitor endpoint params, same client-side service/threshold
 * filtering, the same $x.xxm formatting and the same 110%/95% mark-color
 * thresholds (including the `mark-cell-<color>` testids), default-sorted by
 * divergence descending. Presentation is Capiro primitives + the module's
 * pe-v2 vocabulary instead of antd Table/Select/InputNumber/Tag.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getMarkupMonitor } from '../../../pages/program-element/api.js';
import type { ProgramElementMarkupMonitorItem } from '../../../pages/program-element/types.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { PeSkeletonBlock } from './pe-primitives.js';
import './pe-workspace.css';

function dollarsMm(value: number | null | undefined): string {
  if (value == null) return '-';
  return `$${value.toFixed(2)}m`;
}

function ratioToRequest(mark: number | null, request: number | null): number | null {
  if (mark == null || request == null || request === 0) return null;
  return (mark / request) * 100;
}

function colorForRatio(ratio: number | null): 'green' | 'gold' | 'red' | 'default' {
  if (ratio == null) return 'default';
  if (ratio > 110) return 'green';
  if (ratio >= 95) return 'gold';
  return 'red';
}

const COLOR_TONE: Record<'green' | 'gold' | 'red' | 'default', CapiroBadgeTone> = {
  green: 'success',
  gold: 'warning',
  red: 'danger',
  default: 'neutral',
};

function MarkCell({ value, request }: { value: number | null; request: number | null }) {
  const ratio = ratioToRequest(value, request);
  const color = colorForRatio(ratio);

  return (
    <CapiroBadge tone={COLOR_TONE[color]} data-testid={`mark-cell-${color}`}>
      {dollarsMm(value)}
    </CapiroBadge>
  );
}

function DivergenceBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="pe-v2-divbar">
      <div className="pe-v2-divbar-track" aria-hidden>
        <i className="pe-v2-divbar-fill" style={{ width: `${clamped}%` }} />
      </div>
      <span className="pe-v2-divbar-num">{value.toFixed(1)}%</span>
    </div>
  );
}

type SortKey = 'peCode' | 'request' | 'divergencePct';
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

function compareRows(a: ProgramElementMarkupMonitorItem, b: ProgramElementMarkupMonitorItem, sort: SortState): number {
  let n = 0;
  if (sort.key === 'peCode') n = a.peCode.localeCompare(b.peCode);
  else if (sort.key === 'request') n = (a.request ?? -1) - (b.request ?? -1);
  else n = a.divergencePct - b.divergencePct;
  return sort.dir === 'asc' ? n : -n;
}

export function PeMarkupMonitorPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [divergenceThreshold, setDivergenceThreshold] = useState<number>(0);
  // antd's Table default: divergence descending.
  const [sort, setSort] = useState<SortState>({ key: 'divergencePct', dir: 'desc' });

  const monitorQuery = useQuery({
    queryKey: ['program-element-markup-monitor', serviceFilter, divergenceThreshold],
    queryFn: () =>
      getMarkupMonitor(api, {
        service: serviceFilter === 'all' ? undefined : serviceFilter,
        divergence_threshold: divergenceThreshold,
      }),
    staleTime: 60 * 1000,
  });

  const rows = monitorQuery.data?.data ?? [];

  const serviceOptions = useMemo(() => {
    const values = Array.from(new Set(rows.map((row) => row.service).filter((v): v is string => Boolean(v && v.trim()))));
    return [
      { label: 'All services', value: 'all' },
      ...values.sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value })),
    ];
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows
      .filter((row) => (serviceFilter === 'all' ? true : row.service === serviceFilter))
      .filter((row) => row.divergencePct >= divergenceThreshold)
      .sort((a, b) => compareRows(a, b, sort));
  }, [rows, serviceFilter, divergenceThreshold, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <section className="pe-v2" data-screen-label="Mark-up monitor" style={{ minHeight: '100%' }}>
      <div className="pe-v2-breadcrumb">
        <button type="button" onClick={() => navigate('/program-elements')}>
          Program elements
        </button>
        <span>›</span>
        <span>Monitoring tools</span>
        <span>›</span>
        <span>Mark-up monitor</span>
      </div>

      <div className="pe-v2-page-head" style={{ borderBottom: 'none' }}>
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Mark-up monitor</div>
          <div className="pe-v2-page-sub">
            Committee marks across HASC, SASC, HAC-D and SAC-D for every program element you
            watch, with how far each mark diverges from the President&apos;s Budget request.
          </div>
        </div>
      </div>

      <div className="pe-v2-static-body">
        <div className="pe-v2-card">
          <div className="pe-v2-static-filters">
            <CapiroSelect
              label="Service"
              options={serviceOptions}
              value={serviceFilter}
              onChange={(e) => setServiceFilter(e.target.value)}
            />
            <CapiroInput
              label="Divergence threshold"
              type="number"
              min={0}
              max={100}
              step={1}
              value={divergenceThreshold}
              onChange={(e) => {
                const n = e.target.value === '' ? 0 : Number(e.target.value);
                setDivergenceThreshold(Number.isFinite(n) ? n : 0);
              }}
              helpText="Percent (%)"
            />
          </div>
        </div>

        <div className="pe-v2-card">
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Program element mark-up monitor</div>
          </div>
          {monitorQuery.isLoading ? (
            <div style={{ padding: 24 }}>
              <PeSkeletonBlock rows={6} />
            </div>
          ) : filteredRows.length === 0 ? (
            <div style={{ padding: '32px 24px' }}>
              <CapiroEmptyState title="Watch some PEs to populate this view" />
            </div>
          ) : (
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell aria-sort={sort.key === 'peCode' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button type="button" className="pe-v2-th-sort" onClick={() => toggleSort('peCode')}>
                        PE code{sortMark('peCode')}
                      </button>
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Title</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell aria-sort={sort.key === 'request' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button type="button" className="pe-v2-th-sort" onClick={() => toggleSort('request')}>
                        Request{sortMark('request')}
                      </button>
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>HASC</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>SASC</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>HAC-D</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>SAC-D</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell aria-sort={sort.key === 'divergencePct' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button type="button" className="pe-v2-th-sort" onClick={() => toggleSort('divergencePct')}>
                        Divergence{sortMark('divergencePct')}
                      </button>
                    </CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {filteredRows.map((row) => (
                    <tr key={row.peCode}>
                      <CapiroTableCell>
                        <span className="pe-v2-mono">{row.peCode}</span>
                      </CapiroTableCell>
                      <CapiroTableCell>{row.title}</CapiroTableCell>
                      <CapiroTableCell>{dollarsMm(row.request)}</CapiroTableCell>
                      <CapiroTableCell>
                        <MarkCell value={row.hascMark} request={row.request} />
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <MarkCell value={row.sascMark} request={row.request} />
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <MarkCell value={row.hacDMark} request={row.request} />
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <MarkCell value={row.sacDMark} request={row.request} />
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <DivergenceBar value={row.divergencePct} />
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          )}
        </div>
      </div>
    </section>
  );
}
