/**
 * Shared single-STATE-bill detail (State Legislation Platform, S7.3) — the
 * jurisdiction-aware twin of `bill-detail.tsx`'s `BillDetailBody`. Reuses its
 * exported `DrillSection`/`DrillKV`/`ChipList`/`formatDate` so both the Data
 * Explorer drill-in and the Radar bill side-drawer (`BillDrawer`'s jurisdiction
 * switch) render the exact same detail with no duplicated fetch logic.
 *
 * DD7: no bill-text blobs — versions render as metadata (type/date/official
 * link) only. No status LADDER in P0 (none exists federally either — parity,
 * not gold-plating); the status pill is the S3 canonical derivation as-is.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Empty, Skeleton, Tag } from 'antd';
import { stateBillStatusLabel } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import { ChipList, DrillSection, DrillKV, formatDate } from './bill-detail.js';
import type { StateBillDetail } from './explorerTypes.js';

const LINK_TYPE_LABEL: Record<string, string> = {
  same_as: 'Same as',
  companion: 'Companion',
  similar: 'Similar',
  replaces: 'Replaces',
  replaced_by: 'Replaced by',
};

/** Read-only single-state-bill detail. Same query key as the Explorer drill-in
 *  so both surfaces share one react-query cache entry per bill. */
export function useStateBillDetail(id: string | null | undefined) {
  const api = useApi();
  return useQuery<StateBillDetail | null>({
    queryKey: ['explorer-state-bill-detail', id],
    queryFn: async () =>
      (await api.get<StateBillDetail>(`/api/explorer/state-bills/${encodeURIComponent(id ?? '')}`))
        .data,
    enabled: Boolean(id),
  });
}

/** Loading skeleton / not-found / rendered detail for a state bill. `extra` is
 *  rendered below the standard sections (mirrors BillDetailBody's contract). */
export function StateBillDetailBody({ id, extra }: { id: string; extra?: ReactNode }) {
  const query = useStateBillDetail(id);
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="State bill not found." />;
  const { bill: b } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Bill">
        <DrillKV
          label="Identifier"
          value={<Tag className="redesign-mono-tag">{`${b.state} ${b.identifier}`}</Tag>}
        />
        <DrillKV label="Session" value={<span className="num">{b.session}</span>} />
        <DrillKV label="Title" value={b.title} />
        {b.status ? (
          <DrillKV
            label="Status"
            value={
              <span>
                <Tag className="redesign-mono-tag">{stateBillStatusLabel(b.status)}</Tag>
                {b.statusAt ? (
                  <span
                    className="num"
                    style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-3)' }}
                  >
                    as of {formatDate(b.statusAt)}
                  </span>
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
                  <span
                    className="num"
                    style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}
                  >
                    {formatDate(b.latestActionDate)}
                  </span>
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
          <p style={{ fontSize: 13, lineHeight: 1.55 }}>{b.abstract}</p>
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
          <ul className="drill-list">
            {b.actions.map((a) => (
              <li key={a.id}>
                <span className="num">{formatDate(a.date)}</span>
                <span>{a.text}</span>
                {a.chamber ? (
                  <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{a.chamber}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {b.votes.length ? (
        <DrillSection title="Roll-call votes">
          <ul className="drill-list">
            {b.votes.map((v) => (
              <li key={v.id}>
                <span className="num">{formatDate(v.date)}</span>
                <span>
                  {v.motion ?? 'Vote'}
                  {v.chamber ? ` (${v.chamber})` : ''}
                </span>
                <span
                  className="num"
                  style={{ color: v.passed ? 'var(--success, #1a7f37)' : 'var(--ink-3)' }}
                >
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
          <ul className="drill-list">
            {b.versions.map((v) => (
              <li key={v.id}>
                <span className="num">{formatDate(v.date)}</span>
                <span>{v.versionType}</span>
                {v.stateUrl ? (
                  <a href={v.stateUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
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
          <ul className="drill-list">
            {b.links.map((l) => (
              <li key={l.id}>
                <span>{LINK_TYPE_LABEL[l.linkType] ?? l.linkType}</span>
                <span className="num">{l.relatedBillKey ?? '(not yet ingested)'}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {extra}
    </div>
  );
}
