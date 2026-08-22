/**
 * Defense Budget vNext — source coverage, wired to the Phase 8 Session 11
 * lifecycle read routes now served by `apps/api` (see
 * `docs/defense-budget/defense-budget-vnext-implementation-map.md` §2 — these
 * routes exist and are DB-rehearsed, but had no reachable ALB route before
 * this ship; this component is the first UI to actually call them).
 *
 * Translates the internal state vocabulary into the product vocabulary from
 * `docs/prototypes/defense-budget-vnext-design.md` §5 (Current / Changed /
 * Pending publication / Processing / Review needed / Stale / Source
 * unavailable) — no SHA, lease, worker id, cursor or raw job state ever
 * reaches this surface.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getCycleHealth, type CycleHealth } from '../defense-budget-lifecycle/defense-budget-lifecycle-api.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { familyById, type DefenseBudgetFy } from './defense-budget-context.js';

function coveragePct(health: CycleHealth): number | null {
  if (health.expectedSources <= 0) return null;
  return Math.round((health.published / health.expectedSources) * 1000) / 10;
}

/**
 * A budget family with neither a canonical line-level projection nor
 * lifecycle source-family tracking is disclosed as not yet tracked — never
 * silently rendered as an empty coverage meter (task §9).
 */
export function DefenseBudgetFamilyCoverageNote({ familyId, fy }: { familyId: string; fy: DefenseBudgetFy }) {
  const family = familyById(familyId);
  const api = useApi();
  const fiscalYear = 2000 + Number(fy.slice(2));
  const health = useQuery({
    queryKey: ['defense-budget-cycle-health', fiscalYear],
    queryFn: () => getCycleHealth(api, fiscalYear),
    enabled: !!family.sourceFamilies?.length,
    staleTime: 60_000,
    retry: false,
  });

  if (family.id === 'All') return null;

  if (!family.sourceFamilies?.length) {
    return (
      <div className="pe-ws-pad pe-ws-pad--tall defense-budget-family-note">
        <div className="pe-v2-page-title" style={{ fontSize: 16 }}>
          {family.label} is not yet tracked
        </div>
        <p className="pe-ws-cap" style={{ maxWidth: 560 }}>
          Neither line-level budget data nor official-source discovery covers {family.label} yet for {fy}. This
          is a genuine gap, not a failed query — the family filter exists so it can be checked, and will show real
          rows and coverage the moment either exists.
        </p>
      </div>
    );
  }

  if (health.isLoading) {
    return (
      <div className="pe-ws-pad defense-budget-family-note">
        <CapiroSkeleton height={14} width="48%" />
      </div>
    );
  }
  if (health.isError || !health.data) {
    return (
      <div className="pe-ws-pad defense-budget-family-note">
        <p className="pe-ws-cap">Source coverage for {fy} failed to load. Retry before treating this family as empty.</p>
      </div>
    );
  }

  const h = health.data;
  const pct = coveragePct(h);
  return (
    <div className="pe-ws-pad defense-budget-family-note">
      <div className="pe-v2-page-title" style={{ fontSize: 16 }}>
        {family.label} — official {fy} source coverage is tracked; line-level extraction may not be
      </div>
      <p className="pe-ws-cap" style={{ maxWidth: 640 }}>
        {h.expectedSources === 0
          ? `No ${fy} sources are expected yet for this family.`
          : `${h.published} of ${h.expectedSources} expected ${fy} sources published${pct != null ? ` (${pct}%)` : ''} · ${h.notFiled} not filed · ${h.reviewBacklog} in review.`}{' '}
        Rows below reflect only what has completed line-level extraction — an official document existing does not
        by itself mean a project or account row exists yet.
      </p>
    </div>
  );
}

/** Segmented coverage meter — design doc §4 "Sources & proof": one meter, current / awaiting / unavailable / processing. */
export function DefenseBudgetCoverageMeter({ fiscalYear }: { fiscalYear: number }) {
  const api = useApi();
  const health = useQuery({
    queryKey: ['defense-budget-cycle-health', fiscalYear],
    queryFn: () => getCycleHealth(api, fiscalYear),
    staleTime: 60_000,
    retry: false,
  });

  if (health.isLoading) {
    return (
      <div className="pe-pf-card" style={{ padding: 16 }}>
        <CapiroSkeleton height={14} width="64%" />
      </div>
    );
  }
  if (health.isError || !health.data) {
    return (
      <div className="pe-pf-card" style={{ padding: 16 }}>
        <p className="pe-pf-eyebrow-quiet">FY{fiscalYear} source coverage failed to load. Retry before treating it as unavailable.</p>
      </div>
    );
  }

  const h = health.data;
  const total = h.expectedSources;
  const pct = coveragePct(h);
  const segments = [
    { label: 'Current', count: h.published, tone: 'success' as const },
    { label: 'Pending publication', count: h.notFiled, tone: 'neutral' as const },
    { label: 'Review needed', count: h.reviewRequired, tone: 'warning' as const },
    { label: 'Source unavailable', count: h.failedDownloads, tone: 'danger' as const },
  ];

  return (
    <div className="pe-pf-card defense-budget-coverage-meter">
      <div className="pe-pf-card-head">
        <div className="pe-pf-card-title">
          FY{fiscalYear} source coverage — {total === 0 ? 'nothing expected yet' : `${h.published} of ${total}${pct != null ? ` · ${pct}%` : ''}`}
        </div>
        <div style={{ flex: 1, minWidth: 8 }} />
        <span className="pe-pf-eyebrow-quiet">MISSING IS NEVER ZERO</span>
      </div>
      {total === 0 ? (
        <p style={{ padding: '10px 16px 14px', fontSize: 13, color: 'var(--pepf-body)' }}>
          FY{fiscalYear} is not yet an expected-source cycle. This is not a failed load.
        </p>
      ) : (
        <>
          <div className="defense-budget-coverage-meter__bar" role="img" aria-label={`${h.published} of ${total} sources current`}>
            {segments.map((s) =>
              s.count > 0 ? (
                <span
                  key={s.label}
                  className={`defense-budget-coverage-meter__seg is-${s.tone}`}
                  style={{ flexGrow: s.count }}
                  title={`${s.label}: ${s.count}`}
                />
              ) : null,
            )}
          </div>
          <div className="defense-budget-coverage-meter__legend">
            {segments.map((s) => (
              <span key={s.label} className={`defense-budget-coverage-meter__legend-item is-${s.tone}`}>
                {s.label} · {s.count}
              </span>
            ))}
          </div>
          {h.staleAdapters.length > 0 ? (
            <p className="pe-pf-eyebrow-quiet" style={{ padding: '0 16px 14px' }}>
              {h.staleAdapters.length} source{h.staleAdapters.length === 1 ? '' : 's'} stale — has not refreshed recently
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
