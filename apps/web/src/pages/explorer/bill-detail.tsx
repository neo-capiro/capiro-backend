/**
 * Shared single-bill detail — the ONE read source for a Congress bill's full
 * record (title/sponsor/subjects/actions timeline/latest action/links).
 *
 * Extracted from DataExplorerPage's `BillDetailView` so the Radar bill
 * side-drawer (P7, spec D9: opening a bill NEVER routes to Data Explorer) renders
 * the exact same detail with no navigation and no duplicated fetch logic. Both
 * the Explorer drill-in drawer and the Radar BillDrawer call `useBillDetail` and
 * render `<BillDetailBody>`; the drawer passes `extra` to inject its
 * "Discussed in hearings" section + "Track for client" affordance.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Empty, Skeleton, Tag } from 'antd';
import { useApi } from '../../lib/use-api.js';
import type { BillDetail } from './explorerTypes.js';

/** Read-only single-bill detail. Same query key as the Explorer drill-in so the
 *  two surfaces share one react-query cache entry per bill. */
export function useBillDetail(billId: string | null | undefined) {
  const api = useApi();
  return useQuery<BillDetail | null>({
    queryKey: ['explorer-bill-detail', billId],
    queryFn: async () =>
      (await api.get<BillDetail>(`/api/explorer/congress-bills/${encodeURIComponent(billId ?? '')}`)).data,
    enabled: Boolean(billId),
  });
}

/** Loading skeleton / not-found / rendered detail for a bill. `extra` is rendered
 *  below the standard sections (used by the Radar drawer for hearing links). */
export function BillDetailBody({
  id,
  extra,
}: {
  id: string;
  extra?: ReactNode;
}) {
  const query = useBillDetail(id);
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Bill not found." />;
  const { bill } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Bill">
        <DrillKV
          label="Number"
          value={
            <span className="num" style={{ fontWeight: 600 }}>
              {bill.billType} {bill.billNumber}
            </span>
          }
        />
        <DrillKV label="Congress" value={`${bill.congress}th`} />
        <DrillKV label="Title" value={bill.title} />
        <DrillKV
          label="Sponsor"
          value={`${bill.sponsorName ?? '-'}${bill.sponsorParty ? ` (${bill.sponsorParty}-${bill.sponsorState ?? ''})` : ''}`}
        />
        <DrillKV label="Introduced" value={bill.introducedDate ? formatDate(bill.introducedDate) : '-'} />
        <DrillKV label="Origin chamber" value={bill.originChamber ?? '-'} />
        <DrillKV label="Policy area" value={bill.policyArea ?? '-'} />
        <DrillKV label="Cosponsors" value={<span className="num">{bill.cosponsorsCount}</span>} />
        <DrillKV
          label="Latest action"
          value={
            <span>
              {bill.latestActionText ?? '-'}
              {bill.latestActionDate ? (
                <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}>
                  {formatDate(bill.latestActionDate)}
                </span>
              ) : null}
            </span>
          }
        />
        {bill.url ? (
          <DrillKV
            label="Congress.gov"
            value={
              <a href={bill.url} target="_blank" rel="noreferrer">
                View on Congress.gov →
              </a>
            }
          />
        ) : null}
      </DrillSection>

      {bill.subjects.length ? (
        <DrillSection title="Subjects">
          <ChipList items={bill.subjects} max={20} />
        </DrillSection>
      ) : null}

      {bill.actions.length ? (
        <DrillSection title="Recent actions">
          <ul className="drill-list">
            {bill.actions.map((a) => (
              <li key={a.id}>
                <span className="num">{formatDate(a.date)}</span>
                <span>{a.text}</span>
                {a.chamber ? <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{a.chamber}</span> : null}
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {extra}
    </div>
  );
}

/* ── presentational helpers (mirror DataExplorerPage's private drill bits so the
      detail body renders identically wherever it's mounted) ─────────────────── */

export function DrillSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="drill-section">
      <h3 className="drill-section-title">{title}</h3>
      {children}
    </section>
  );
}

export function DrillKV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="drill-kv">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

export function ChipList({ items, max }: { items: string[]; max: number }) {
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.slice(0, max).map((it) => (
        <Tag key={it} className="redesign-mono-tag">
          {it}
        </Tag>
      ))}
      {items.length > max ? <Tag>+{items.length - max}</Tag> : null}
    </span>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
