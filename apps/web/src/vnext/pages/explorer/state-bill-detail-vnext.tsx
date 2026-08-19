/**
 * State bill detail body — vNext re-skin of `pages/explorer/state-bill-detail.tsx`'s
 * `StateBillDetailBody`. Same `useStateBillDetail` hook (extracted to the
 * UI-free `state-bill-detail-data.ts`) → same query key → one cache entry per
 * bill across surfaces. Sections, labels and copy are identical (DD7 intact:
 * versions render as metadata only, no bill-text blobs).
 */
import type { ReactNode } from 'react';
import { stateBillStatusLabel } from '@capiro/shared';
import {
  LINK_TYPE_LABEL,
  useStateBillDetail,
} from '../../../pages/explorer/state-bill-detail-data.js';
import { formatDate } from './explorer-format.js';
import { ChipList, MonoTag, XpEmpty, XpSkeletonRows } from './explorer-table.js';
import { DrillKV, DrillSection } from './explorer-drill-bits.js';

export function StateBillDetailBodyVNext({ id, extra }: { id: string; extra?: ReactNode }) {
  const query = useStateBillDetail(id);
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="State bill not found." />;
  const { bill: b } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Bill">
        <DrillKV label="Identifier" value={<MonoTag>{`${b.state} ${b.identifier}`}</MonoTag>} />
        <DrillKV label="Session" value={<span className="xp-num">{b.session}</span>} />
        <DrillKV label="Title" value={b.title} />
        {b.status ? (
          <DrillKV
            label="Status"
            value={
              <span>
                <MonoTag>{stateBillStatusLabel(b.status)}</MonoTag>
                {b.statusAt ? (
                  <span className="xp-num xp-drill-inline-note">as of {formatDate(b.statusAt)}</span>
                ) : null}
              </span>
            }
          />
        ) : null}
        {b.chamber ? <DrillKV label="Chamber" value={b.chamber} /> : null}
        {b.sponsorName ? (
          <DrillKV
            label="Sponsor"
            value={`${b.sponsorName}${b.sponsorParty ? ` (${b.sponsorParty})` : ''}`}
          />
        ) : null}
        {b.latestActionText || b.latestActionDate ? (
          <DrillKV
            label="Latest action"
            value={
              <span>
                {b.latestActionText ?? '-'}
                {b.latestActionDate ? (
                  <span className="xp-num xp-drill-subdate">{formatDate(b.latestActionDate)}</span>
                ) : null}
              </span>
            }
          />
        ) : null}
        {b.stateUrl ? (
          <DrillKV
            label="Official site"
            value={
              <a href={b.stateUrl} target="_blank" rel="noreferrer">
                Open on the state legislature's site →
              </a>
            }
          />
        ) : b.url ? (
          <DrillKV
            label="Source"
            value={
              <a href={b.url} target="_blank" rel="noreferrer">
                Open on LegiScan/OpenStates →
              </a>
            }
          />
        ) : null}
      </DrillSection>

      {b.abstract ? (
        <DrillSection title="Abstract">
          <p className="xp-drill-para">{b.abstract}</p>
        </DrillSection>
      ) : null}

      {b.subjects?.length ? (
        <DrillSection title="Subjects">
          <ChipList items={b.subjects} max={20} />
        </DrillSection>
      ) : null}

      {b.classification?.length ? (
        <DrillSection title="Classification">
          <ChipList items={b.classification} max={10} />
        </DrillSection>
      ) : null}

      {b.actions.length ? (
        <DrillSection title="Recent actions">
          <ul className="xp-drill-list">
            {b.actions.map((a) => (
              <li key={a.id}>
                <span className="xp-num">{formatDate(a.date)}</span>
                <span>{a.text}</span>
                {a.chamber ? <span className="xp-drill-list__note">{a.chamber}</span> : null}
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {b.votes.length ? (
        <DrillSection title="Roll-call votes">
          <ul className="xp-drill-list">
            {b.votes.map((v) => (
              <li key={v.id}>
                <span className="xp-num">{formatDate(v.date)}</span>
                <span>
                  {v.motion ?? 'Vote'}
                  {v.chamber ? ` (${v.chamber})` : ''}
                </span>
                <span className={`xp-num ${v.passed ? 'xp-vote--passed' : 'xp-muted'}`}>
                  {v.yeas}-{v.nays}
                  {v.nv ? `-${v.nv} NV` : ''}
                  {v.absent ? `, ${v.absent} absent` : ''}
                  {v.passed != null ? (v.passed ? ' · Passed' : ' · Failed') : ''}
                </span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {b.versions.length ? (
        <DrillSection title="Versions">
          <ul className="xp-drill-list">
            {b.versions.map((v) => (
              <li key={v.id}>
                <span className="xp-num">{formatDate(v.date)}</span>
                <span>{v.versionType}</span>
                {v.stateUrl ? (
                  <a href={v.stateUrl} target="_blank" rel="noreferrer" className="xp-drill-list__link">
                    Official link →
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {b.links.length ? (
        <DrillSection title="Related bills">
          <ul className="xp-drill-list">
            {b.links.map((l) => (
              <li key={l.id}>
                <span>{LINK_TYPE_LABEL[l.linkType] ?? l.linkType}</span>
                <span className="xp-num">{l.relatedBillKey ?? '(not yet ingested)'}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {extra}
    </div>
  );
}
