/**
 * Capability finder (F4 + F25) — native vNext port of
 * `pages/program-element/CapabilityFinder.tsx` (re-skin: identical endpoints,
 * query keys, copy, empty/loading/error states; presentation on the token
 * layer). "I sell X — where's the money?" — no PE code required. Curated
 * capability taxonomy, deterministic auditable matches; recommendations ranked
 * by appropriability with the entry wedge (F25) chip.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  getCapabilities,
  getCapabilityRecommendations,
  searchCapabilityLines,
} from '../../../../pages/program-element/api.js';
import { LINE_TYPES } from '../../../../pages/program-element/pe-shared-model.js';
import { fmtMoneyM } from '../../../../pages/program-element/charts/index.js';
import {
  STAGE_LABEL,
  type FundingStage,
} from '../../../../pages/program-element/funding-model.js';
import type { CapabilityRecommendation } from '../../../../pages/program-element/types.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { PeFbChevronRightIcon, PeFbCompassIcon } from './pe-fallback-icons.js';
import {
  ActionSignalChipVNext,
  LineTypeBadgeVNext,
  MaturityMiniVNext,
  PeCodeBadgeVNext,
  PeFbEmpty,
  PeFbErrorState,
  PeFbSkeleton,
  ServiceCellVNext,
  TierBadgeVNext,
} from './pe-fallback-ui.js';

const WEDGE_META: Record<string, { label: string; color: string }> = {
  'procurement-transition': { label: 'Procurement transition', color: '#1A6E78' },
  'rdte-eval': { label: 'RDT&E evaluation', color: '#2A57CE' },
  'report-language': { label: 'Report language', color: '#A26913' },
  'ota-sbir-diu': { label: 'OTA / SBIR / DIU', color: '#7A5C3A' },
  'om-services': { label: 'O&M services', color: '#4E5A86' },
  'urgent-need': { label: 'Urgent operational need', color: '#B5301B' },
};

function WedgeChip({ wedge }: { wedge: string }) {
  const w = WEDGE_META[wedge] ?? { label: wedge, color: 'var(--capiro-color-text-muted)' };
  return (
    <span className="pe-fb-wedge-chip" style={{ color: w.color, background: `${w.color}18` }}>
      {w.label}
    </span>
  );
}

/** One ranked budget-line row — shared by curated recommendations and semantic search. */
function RecRow({
  r,
  rank,
  onOpen,
  evidence,
}: {
  r: CapabilityRecommendation;
  rank: number;
  onOpen: (peCode: string) => void;
  evidence: React.ReactNode;
}) {
  return (
    <div className="pe-fb-rec-row" onClick={() => onOpen(r.peCode)}>
      <div className="pe-fb-rec-rank">{rank}</div>
      <div className="pe-fb-rec-main">
        <div className="pe-fb-rec-top">
          <PeCodeBadgeVNext code={r.peCode} />
          <span className="pe-fb-rec-name">{r.title}</span>
          <LineTypeBadgeVNext lineType={r.lineType} small />
        </div>
        <div className="pe-fb-rec-foot">
          <WedgeChip wedge={r.wedge} />
          <ServiceCellVNext service={r.service} />
          <span className="pe-fb-rec-money">
            {r.latestCurrent != null
              ? `${fmtMoneyM(r.latestCurrent)}${r.latestCurrentFy ? ` · FY${String(r.latestCurrentFy).slice(-2)}` : ''}${
                  r.latestCurrentStage && r.latestCurrentStage !== 'none'
                    ? ` · ${STAGE_LABEL[r.latestCurrentStage as FundingStage] ?? r.latestCurrentStage}`
                    : ''
                }`
              : r.latestRequest != null
                ? `${fmtMoneyM(r.latestRequest)}${r.latestRequestFy ? ` · FY${String(r.latestRequestFy).slice(-2)}` : ''}`
                : '—'}
          </span>
          {evidence}
        </div>
      </div>
      <div className="pe-fb-rec-right">
        {r.appropScore != null ? (
          <TierBadgeVNext tier={r.appropTier} label={`Approp ${r.appropScore}`} />
        ) : (
          <span className="pe-fb-dash">—</span>
        )}
        <MaturityMiniVNext value={r.maturity} />
        <ActionSignalChipVNext type={r.signalType} tone={r.signalTone} />
        <PeFbChevronRightIcon className="pe-fb-rec-chev" />
      </div>
    </div>
  );
}

/** Full Capability finder module view. */
export function PeCapabilityFinderVNext({
  initialSlug,
  initialQuery,
  onOpen,
}: {
  initialSlug: string | null;
  /** Free-text query from the hero — opens in semantic-search mode. */
  initialQuery?: string | null;
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
  const [searchQ, setSearchQ] = useState<string | null>(initialQuery?.trim() || null);
  const activeSlug = slug ?? initialSlug ?? caps[0]?.slug ?? null;

  const recsQuery = useQuery({
    queryKey: ['budget-lines-capability-recs', activeSlug],
    queryFn: () => getCapabilityRecommendations(api, activeSlug as string),
    enabled: !!activeSlug && !searchQ,
    staleTime: 5 * 60 * 1000,
  });

  const searchQuery = useQuery({
    queryKey: ['budget-lines-capability-search', searchQ],
    queryFn: () => searchCapabilityLines(api, searchQ as string),
    enabled: !!searchQ,
    staleTime: 5 * 60 * 1000,
  });

  if (capsQuery.isLoading) return <PeFbSkeleton rows={6} />;
  if (capsQuery.isError) {
    return <PeFbErrorState message="Unable to load capabilities" />;
  }
  if (caps.length === 0 && !searchQ) {
    return (
      <PeFbEmpty description="The capability taxonomy hasn't been seeded yet. Once seed-capabilities runs, lines matched to each capability appear here with auditable evidence." />
    );
  }

  // ── Semantic-search mode: AI suggestions ranked by mission similarity. ──
  // Deliberately a separate, clearly-labeled surface so the curated taxonomy's
  // "every match carries its evidence" story is never diluted.
  if (searchQ) {
    const rows = searchQuery.data?.data ?? [];
    return (
      <div className="pe-fb-cap-finder">
        <div className="pe-fb-idx-card">
          <div className="pe-fb-idx-card-head">
            <h3>Semantic matches for “{searchQ}”</h3>
            <span className="pe-fb-idx-count">
              AI suggestions ranked by mission similarity — not curated evidence
            </span>
            <CapiroButton size="compact" onClick={() => setSearchQ(null)}>
              Back to capabilities
            </CapiroButton>
          </div>
          {searchQuery.isLoading ? (
            <PeFbSkeleton rows={5} />
          ) : searchQuery.isError ? (
            <PeFbErrorState message="Search failed — try again." />
          ) : rows.length === 0 ? (
            <PeFbEmpty description="No confident matches for that phrase — try a capability chip, or rephrase (e.g. 'counter-UAS radar')." />
          ) : (
            <div className="pe-fb-rec-list">
              {rows.map((r, i) => (
                <RecRow
                  key={r.peCode}
                  r={r}
                  rank={i + 1}
                  onOpen={onOpen}
                  evidence={
                    <span
                      className="pe-fb-rec-evidence"
                      title="Semantic similarity between your phrase and this line's mission text — an AI suggestion, not a curated match"
                    >
                      ≈{r.matchedOn.replace(/^semantic:/, '')} · AI suggestion
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const active = caps.find((c) => c.slug === activeSlug) ?? caps[0]!;
  const recs = recsQuery.data?.data ?? [];
  const split = active.requestByLineType;
  const splitEntries = Object.entries(split).filter(([, v]) => v > 0);
  const splitTotal = splitEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="pe-fb-cap-finder">
      <div className="pe-fb-cap-finder-hero">
        <div className="pe-fb-cfh-l">
          <div className="pe-fb-cap-hero-eyebrow">
            <PeFbCompassIcon /> Capability → money
          </div>
          <h2 className="pe-fb-cfh-q">
            Where&apos;s the money for{' '}
            <span className="pe-fb-cfh-blank">{active.name.split(' / ')[0]}</span>?
          </h2>
          <div className="pe-fb-cfh-path">{active.taxonomyPath}</div>
          <div className="pe-fb-cfh-aliases">
            {active.aliases.map((a) => (
              <span key={a} className="pe-fb-alias-chip">
                {a}
              </span>
            ))}
          </div>
        </div>
        <div className="pe-fb-cfh-r">
          <div className="pe-fb-cfh-total">{fmtMoneyM(active.requestTotal)}</div>
          <div className="pe-fb-cfh-total-l">
            latest requests across {active.lineCount} matched line
            {active.lineCount === 1 ? '' : 's'}
          </div>
          {splitTotal > 0 ? (
            <>
              <div className="pe-fb-com-bar">
                {splitEntries.map(([lt, v]) => (
                  <span
                    key={lt}
                    className="pe-fb-com-seg"
                    style={{
                      width: `${(v / splitTotal) * 100}%`,
                      background: LINE_TYPES[lt]?.color ?? 'var(--capiro-color-text-muted)',
                    }}
                    title={`${LINE_TYPES[lt]?.short ?? lt}: ${fmtMoneyM(v)}`}
                  />
                ))}
              </div>
              <div className="pe-fb-cfh-split">
                {splitEntries.map(([lt, v]) => (
                  <span key={lt}>
                    <span
                      className="pe-fb-dot"
                      style={{ background: LINE_TYPES[lt]?.color ?? 'var(--capiro-color-text-muted)' }}
                    />
                    {LINE_TYPES[lt]?.short ?? lt} {fmtMoneyM(v)}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="pe-fb-cap-picker">
        {caps.map((c) => (
          <button
            key={c.slug}
            type="button"
            className={`pe-fb-cap-pick${c.slug === active.slug ? ' on' : ''}`}
            onClick={() => setSlug(c.slug)}
          >
            {c.name.split(' / ')[0]}
            <span className="pe-fb-cap-pick-n">{c.lineCount}</span>
          </button>
        ))}
      </div>

      <div className="pe-fb-idx-card">
        <div className="pe-fb-idx-card-head">
          <h3>Recommended budget lines</h3>
          <span className="pe-fb-idx-count">
            ranked by appropriability · every match carries its evidence
          </span>
        </div>
        {recsQuery.isLoading ? (
          <PeFbSkeleton rows={5} />
        ) : recs.length === 0 ? (
          <PeFbEmpty description="No lines matched this capability yet." />
        ) : (
          <div className="pe-fb-rec-list">
            {recs.map((r, i) => (
              <RecRow
                key={r.peCode}
                r={r}
                rank={i + 1}
                onOpen={onOpen}
                evidence={
                  <span className="pe-fb-rec-evidence" title={`Match evidence: ${r.matchedOn}`}>
                    matched on {r.matchedOn.replace(/^(title|description):/, '$1 ')}
                  </span>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
