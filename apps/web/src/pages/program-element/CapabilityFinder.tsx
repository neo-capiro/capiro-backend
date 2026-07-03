import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Input, Skeleton } from 'antd';
import { CompassOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { getCapabilities, getCapabilityRecommendations } from './api.js';
import {
  ActionSignalChip,
  LINE_TYPES,
  LineTypeBadge,
  MaturityMini,
  PeCodeBadge,
  ServiceCell,
  TierBadge,
} from './pe-shared.js';
import { fmtMoneyM } from './charts/index.js';
import type { CapabilitySummary } from './types.js';

/**
 * Capability finder (F4 + F25): "I sell X — where's the money?" — no PE code
 * required. Curated capability taxonomy, deterministic auditable matches;
 * recommendations ranked by appropriability with the entry wedge (F25) chip.
 */

const WEDGE_META: Record<string, { label: string; color: string }> = {
  'procurement-transition': { label: 'Procurement transition', color: '#1A6E78' },
  'rdte-eval': { label: 'RDT&E evaluation', color: '#2A57CE' },
  'report-language': { label: 'Report language', color: '#A26913' },
  'ota-sbir-diu': { label: 'OTA / SBIR / DIU', color: '#7A5C3A' },
  'om-services': { label: 'O&M services', color: '#4E5A86' },
  'urgent-need': { label: 'Urgent operational need', color: '#B5301B' },
};

function WedgeChip({ wedge }: { wedge: string }) {
  const w = WEDGE_META[wedge] ?? { label: wedge, color: 'var(--ink-3)' };
  return (
    <span className="pe-wedge-chip" style={{ color: w.color, background: `${w.color}18` }}>
      {w.label}
    </span>
  );
}

/** Search hero shown at the top of the Budget Lines catalog (capEntry=prominent). */
export function CapabilityHero({
  capabilities,
  onFind,
  loading,
}: {
  capabilities: CapabilitySummary[];
  onFind: (slug: string) => void;
  loading: boolean;
}) {
  const [q, setQ] = useState('');
  const suggested = capabilities.slice(0, 6);
  const submit = () => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      if (capabilities[0]) onFind(capabilities[0].slug);
      return;
    }
    const hit =
      capabilities.find(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.aliases.some((a) => a.toLowerCase().includes(needle)),
      ) ?? capabilities[0];
    if (hit) onFind(hit.slug);
  };
  if (loading) return null;
  if (capabilities.length === 0) return null; // taxonomy not seeded yet — no fake hero
  return (
    <div className="pe-cap-hero">
      <div className="pe-cap-hero-l">
        <div className="pe-cap-hero-eyebrow">
          <CompassOutlined /> Capability → money
        </div>
        <h2 className="pe-cap-hero-q">
          I sell <span className="pe-cap-hero-blank">{q || 'GPS-denied autonomy'}</span> — where&apos;s
          the money?
        </h2>
        <div className="pe-cap-hero-search">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={submit}
            placeholder="Describe a capability — no PE code needed…"
            prefix={<SearchOutlined />}
          />
          <button type="button" className="pe-cap-hero-btn" onClick={submit}>
            Find the money <RightOutlined />
          </button>
        </div>
        <div className="pe-cap-hero-chips">
          <span className="pe-cap-hero-try">Try:</span>
          {suggested.map((c) => (
            <button key={c.slug} type="button" className="pe-cap-chip" onClick={() => onFind(c.slug)}>
              {c.name.split(' / ')[0]}
            </button>
          ))}
        </div>
      </div>
      <div className="pe-cap-hero-r">
        <div className="pe-cap-hero-stat">
          <div className="pe-chs-v">{capabilities.length}</div>
          <div className="pe-chs-l">capabilities mapped</div>
        </div>
        <div className="pe-cap-hero-stat">
          <div className="pe-chs-v">{capabilities.reduce((s, c) => s + c.lineCount, 0)}</div>
          <div className="pe-chs-l">matched budget lines</div>
        </div>
        <div className="pe-cap-hero-stat">
          <div className="pe-chs-v">
            {fmtMoneyM(capabilities.reduce((s, c) => s + c.requestTotal, 0))}
          </div>
          <div className="pe-chs-l">latest requests, matched lines</div>
        </div>
      </div>
    </div>
  );
}

/** Full Capability finder module view. */
export function CapabilityFinder({
  initialSlug,
  onOpen,
}: {
  initialSlug: string | null;
  onOpen: (peCode: string) => void;
}) {
  const api = useApi();
  const capsQuery = useQuery({
    queryKey: ['budget-lines-capabilities'],
    queryFn: () => getCapabilities(api),
    staleTime: 5 * 60 * 1000,
  });
  const caps = useMemo(() => capsQuery.data ?? [], [capsQuery.data]);
  const [slug, setSlug] = useState<string | null>(initialSlug);
  const activeSlug = slug ?? initialSlug ?? caps[0]?.slug ?? null;

  const recsQuery = useQuery({
    queryKey: ['budget-lines-capability-recs', activeSlug],
    queryFn: () => getCapabilityRecommendations(api, activeSlug as string),
    enabled: !!activeSlug,
    staleTime: 5 * 60 * 1000,
  });

  if (capsQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (capsQuery.isError) {
    return <Alert type="error" showIcon message="Unable to load capabilities" />;
  }
  if (caps.length === 0) {
    return (
      <Empty description="The capability taxonomy hasn't been seeded yet. Once seed-capabilities runs, lines matched to each capability appear here with auditable evidence." />
    );
  }

  const active = caps.find((c) => c.slug === activeSlug) ?? caps[0]!;
  const recs = recsQuery.data?.data ?? [];
  const split = active.requestByLineType;
  const splitEntries = Object.entries(split).filter(([, v]) => v > 0);
  const splitTotal = splitEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="pe-cap-finder">
      <div className="pe-cap-finder-hero">
        <div className="pe-cfh-l">
          <div className="pe-cap-hero-eyebrow">
            <CompassOutlined /> Capability → money
          </div>
          <h2 className="pe-cfh-q">
            Where&apos;s the money for <span className="pe-cfh-blank">{active.name.split(' / ')[0]}</span>?
          </h2>
          <div className="pe-cfh-path">{active.taxonomyPath}</div>
          <div className="pe-cfh-aliases">
            {active.aliases.map((a) => (
              <span key={a} className="pe-alias-chip">
                {a}
              </span>
            ))}
          </div>
        </div>
        <div className="pe-cfh-r">
          <div className="pe-cfh-total">{fmtMoneyM(active.requestTotal)}</div>
          <div className="pe-cfh-total-l">
            latest requests across {active.lineCount} matched line{active.lineCount === 1 ? '' : 's'}
          </div>
          {splitTotal > 0 ? (
            <>
              <div className="pe-com-bar">
                {splitEntries.map(([lt, v]) => (
                  <span
                    key={lt}
                    className="pe-com-seg"
                    style={{
                      width: `${(v / splitTotal) * 100}%`,
                      background: LINE_TYPES[lt]?.color ?? 'var(--ink-3)',
                    }}
                    title={`${LINE_TYPES[lt]?.short ?? lt}: ${fmtMoneyM(v)}`}
                  />
                ))}
              </div>
              <div className="pe-cfh-split">
                {splitEntries.map(([lt, v]) => (
                  <span key={lt}>
                    <span
                      className="pe-svc-dot"
                      style={{ background: LINE_TYPES[lt]?.color ?? 'var(--ink-3)' }}
                    />
                    {LINE_TYPES[lt]?.short ?? lt} {fmtMoneyM(v)}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="pe-cap-picker">
        {caps.map((c) => (
          <button
            key={c.slug}
            type="button"
            className={`pe-cap-pick${c.slug === active.slug ? ' on' : ''}`}
            onClick={() => setSlug(c.slug)}
          >
            {c.name.split(' / ')[0]}
            <span className="pe-cap-pick-n">{c.lineCount}</span>
          </button>
        ))}
      </div>

      <div className="pe-idx-card">
        <div className="pe-idx-card-head">
          <h3>Recommended budget lines</h3>
          <span className="pe-idx-count">
            ranked by appropriability · every match carries its evidence
          </span>
        </div>
        {recsQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : recs.length === 0 ? (
          <Empty description="No lines matched this capability yet." />
        ) : (
          <div className="pe-rec-list">
            {recs.map((r, i) => (
              <div key={r.peCode} className="pe-rec-row" onClick={() => onOpen(r.peCode)}>
                <div className="pe-rec-rank">{i + 1}</div>
                <div className="pe-rec-main">
                  <div className="pe-rec-top">
                    <PeCodeBadge code={r.peCode} />
                    <span className="pe-rec-name">{r.title}</span>
                    <LineTypeBadge lineType={r.lineType} small />
                  </div>
                  <div className="pe-rec-foot">
                    <WedgeChip wedge={r.wedge} />
                    <ServiceCell service={r.service} />
                    <span className="pe-rec-money">
                      {r.latestRequest != null
                        ? `${fmtMoneyM(r.latestRequest)}${r.latestRequestFy ? ` · FY${String(r.latestRequestFy).slice(-2)}` : ''}`
                        : '—'}
                    </span>
                    <span className="pe-rec-evidence" title={`Match evidence: ${r.matchedOn}`}>
                      matched on {r.matchedOn.replace(/^(title|description):/, '$1 ')}
                    </span>
                  </div>
                </div>
                <div className="pe-rec-right">
                  {r.appropScore != null ? (
                    <TierBadge tier={r.appropTier} label={`Approp ${r.appropScore}`} />
                  ) : (
                    <span className="pe-dash">—</span>
                  )}
                  <MaturityMini value={r.maturity} />
                  <ActionSignalChip type={r.signalType} tone={r.signalTone} />
                  <RightOutlined className="pe-rec-chev" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
