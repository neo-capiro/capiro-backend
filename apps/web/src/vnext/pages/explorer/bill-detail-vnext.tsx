/**
 * Congress bill detail body — vNext re-skin of `pages/explorer/bill-detail.tsx`'s
 * `BillDetailBody`. Data comes from the SAME `useBillDetail` hook (extracted to
 * the UI-free `bill-detail-data.ts`), so this body, the canonical Explorer
 * drill-in and the Radar BillDrawer share one react-query cache entry per bill.
 * Sections, labels and copy are identical; only the chrome is vNext.
 */
import type { ReactNode } from 'react';
import { useBillDetail } from '../../../pages/explorer/bill-detail-data.js';
import { formatDate } from './explorer-format.js';
import { ChipList, XpEmpty, XpSkeletonRows } from './explorer-table.js';
import { DrillKV, DrillSection } from './explorer-drill-bits.js';

export function BillDetailBodyVNext({ id, extra }: { id: string; extra?: ReactNode }) {
  const query = useBillDetail(id);
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Bill not found." />;
  const { bill } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Bill">
        <DrillKV
          label="Number"
          value={
            <span className="xp-num xp-w600">
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
        <DrillKV label="Cosponsors" value={<span className="xp-num">{bill.cosponsorsCount}</span>} />
        <DrillKV
          label="Latest action"
          value={
            <span>
              {bill.latestActionText ?? '-'}
              {bill.latestActionDate ? (
                <span className="xp-num xp-drill-subdate">{formatDate(bill.latestActionDate)}</span>
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
          <ul className="xp-drill-list">
            {bill.actions.map((a) => (
              <li key={a.id}>
                <span className="xp-num">{formatDate(a.date)}</span>
                <span>{a.text}</span>
                {a.chamber ? <span className="xp-drill-list__note">{a.chamber}</span> : null}
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {extra}
    </div>
  );
}
