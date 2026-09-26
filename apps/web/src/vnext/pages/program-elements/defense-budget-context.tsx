/**
 * Defense Budget vNext — shared workspace context.
 *
 * Fiscal year, budget family, service/component, search and watched-only are
 * URL (query) state shared by all five destinations (Explore · Movement ·
 * Congressional · Actions · Portfolio), matching
 * `docs/prototypes/defense-budget-vnext-design.md` §3. The bar is not mounted
 * on the profile route, which carries its own FY control instead (§3: "Two FY
 * controls in one viewport would be two sources of truth").
 *
 * FY is a real server-side filter for the Explore catalog and scopes lifecycle
 * source coverage plus profile deep-links. Movement and markup-monitor retain
 * their own latest-cycle semantics, so those views continue to print the
 * actual FY alongside every figure rather than implying the context year.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import type { ProgramElementSummary } from '../../../pages/program-element/types.js';
import { FilterControl } from './pe-primitives.js';

export type DefenseBudgetFy = `FY${number}`;

const FY_LABEL = /^FY(\d{2})$/;

export function fiscalYearToDefenseBudgetFy(fiscalYear: number): DefenseBudgetFy {
  return `FY${String(Math.trunc(fiscalYear)).slice(-2)}` as DefenseBudgetFy;
}

export function parseDefenseBudgetFy(value: string | null | undefined): DefenseBudgetFy | null {
  if (!value || !FY_LABEL.test(value)) return null;
  return value as DefenseBudgetFy;
}

/** `FY27` → `2027`, the fiscal-year integer the lifecycle read routes take. */
export function fyToFiscalYear(fy: DefenseBudgetFy): number {
  const parsed = parseDefenseBudgetFy(fy);
  if (!parsed) throw new Error(`Invalid defense budget fiscal year: ${fy}`);
  return 2000 + Number(parsed.slice(2));
}

function currentFederalFiscalYear(now = new Date()): number {
  return now.getUTCFullYear() + (now.getUTCMonth() >= 9 ? 1 : 0);
}

function validFiscalYear(value: number | null | undefined): value is number {
  return Number.isInteger(value) && value! >= 2000 && value! <= 2099;
}

export function resolveDefaultDefenseBudgetFy(
  summary?: Pick<ProgramElementSummary, 'latestRequestFy' | 'trend'>,
  now = new Date(),
): DefenseBudgetFy {
  if (validFiscalYear(summary?.latestRequestFy)) {
    return fiscalYearToDefenseBudgetFy(summary.latestRequestFy);
  }
  const trendYears = (summary?.trend ?? []).map((item) => item.fy).filter(validFiscalYear);
  return fiscalYearToDefenseBudgetFy(
    trendYears.length > 0 ? Math.max(...trendYears) : currentFederalFiscalYear(now),
  );
}

/** Build a bounded metadata window and retain a valid explicit deep-link year. */
export function buildDefenseBudgetFyOptions(
  summary?: Pick<ProgramElementSummary, 'latestRequestFy' | 'trend'>,
  explicitFy?: DefenseBudgetFy | null,
  now = new Date(),
): readonly DefenseBudgetFy[] {
  const defaultYear = fyToFiscalYear(resolveDefaultDefenseBudgetFy(summary, now));
  const years = new Set<number>(
    (summary?.trend ?? []).map((item) => item.fy).filter(validFiscalYear),
  );
  if (validFiscalYear(summary?.latestRequestFy)) years.add(summary.latestRequestFy);
  for (let year = defaultYear - 3; year <= defaultYear + 1; year += 1) years.add(year);
  if (explicitFy) years.add(fyToFiscalYear(explicitFy));
  return [...years].sort((a, b) => a - b).map(fiscalYearToDefenseBudgetFy);
}

/**
 * One budget family. `lineType` is the real `QueryProgramElementsDto.line_type`
 * enum value when a canonical line-level product projection exists;
 * `sourceFamilies` are the real `@capiro/defense-domain` `SourceFamily` values
 * when lifecycle source-coverage tracking exists for this family, independent
 * of whether line-level rows do (MILCON's own honest-sparse case, per task
 * §9). A family with neither is disclosed as not yet tracked at all — never
 * silently rendered as empty.
 */
export interface DefenseBudgetFamilyDef {
  id: string;
  label: string;
  lineType?: string;
  sourceFamilies?: readonly string[];
}

export const DEFENSE_BUDGET_FAMILIES: readonly DefenseBudgetFamilyDef[] = Object.freeze([
  { id: 'All', label: 'All' },
  {
    id: 'RDT&E',
    label: 'RDT&E',
    lineType: 'RDTE_PE',
    sourceFamilies: ['pb_r1', 'pb_r2', 'pb_r2a', 'pb_r3', 'pb_r4'],
  },
  {
    id: 'Procurement',
    label: 'Procurement',
    lineType: 'PROCUREMENT_BLIN',
    sourceFamilies: ['pb_p1', 'pb_p_series'],
  },
  { id: 'O&M', label: 'O&M', lineType: 'OM_BLI', sourceFamilies: ['pb_o1', 'pb_op5'] },
  { id: 'MILPERS', label: 'MILPERS' },
  {
    id: 'MILCON',
    label: 'MILCON',
    lineType: 'MILCON_PROJECT',
    sourceFamilies: ['pb_milcon_c1', 'pb_dd1391'],
  },
  { id: 'WCF', label: 'WCF' },
  { id: 'Health', label: 'Health' },
]);

export function familyById(id: string): DefenseBudgetFamilyDef {
  return DEFENSE_BUDGET_FAMILIES.find((f) => f.id === id) ?? DEFENSE_BUDGET_FAMILIES[0]!;
}

export const DEFENSE_BUDGET_SERVICE_OPTIONS = [
  'All',
  'Army',
  'Navy',
  'Marine Corps',
  'Air Force',
  'Space Force',
  'Defense-Wide',
] as const;

const SERVICE_TO_API: Record<string, string> = {
  Army: 'ARMY',
  Navy: 'NAVY',
  'Marine Corps': 'USMC',
  'Air Force': 'AF',
  'Space Force': 'SF',
  'Defense-Wide': 'DW',
};

/** The real `service` query param value for a context-bar service label, or `undefined` for "All". */
export function serviceToApiParam(service: string): string | undefined {
  return service === 'All' ? undefined : SERVICE_TO_API[service];
}

export interface DefenseBudgetContextState {
  fy: DefenseBudgetFy;
  fiscalYear: number;
  family: string;
  service: string;
  q: string;
  watchedOnly: boolean;
  activeFilterCount: number;
  setFy(fy: DefenseBudgetFy): void;
  setFamily(id: string): void;
  setService(label: string): void;
  setQ(value: string): void;
  setWatchedOnly(value: boolean): void;
  reset(): void;
  fyOptions: readonly DefenseBudgetFy[];
}

const DefenseBudgetContext = createContext<DefenseBudgetContextState | null>(null);

export function useDefenseBudgetContext(): DefenseBudgetContextState {
  const ctx = useContext(DefenseBudgetContext);
  if (!ctx) {
    throw new Error('useDefenseBudgetContext must be used within DefenseBudgetContextProvider');
  }
  return ctx;
}

export function DefenseBudgetContextProvider({
  children,
  summary,
}: {
  children: ReactNode;
  summary?: ProgramElementSummary;
}) {
  const [params, setParams] = useSearchParams();

  const explicitFy = parseDefenseBudgetFy(params.get('fy'));
  const defaultFy = resolveDefaultDefenseBudgetFy(summary);
  const fy = explicitFy ?? defaultFy;
  const fyOptions = useMemo(
    () => buildDefenseBudgetFyOptions(summary, explicitFy),
    [explicitFy, summary],
  );
  const family = params.get('family') ?? 'All';
  const service = params.get('svc') ?? 'All';
  const q = params.get('q') ?? '';
  const watchedOnly = params.get('watched') === '1';

  const patch = (next: Readonly<Record<string, string | null>>) => {
    const nextParams = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value == null || value === '') nextParams.delete(key);
      else nextParams.set(key, value);
    }
    setParams(nextParams, { replace: true });
  };

  const value = useMemo<DefenseBudgetContextState>(
    () => ({
      fyOptions,
      fy,
      fiscalYear: fyToFiscalYear(fy),
      family,
      service,
      q,
      watchedOnly,
      activeFilterCount: [family !== 'All', service !== 'All', watchedOnly].filter(Boolean).length,
      setFy: (next) => patch({ fy: next === defaultFy ? null : next }),
      setFamily: (id) => patch({ family: id === 'All' ? null : id }),
      setService: (label) => patch({ svc: label === 'All' ? null : label }),
      setQ: (next) => patch({ q: next || null }),
      setWatchedOnly: (next) => patch({ watched: next ? '1' : null }),
      reset: () => patch({ family: null, svc: null, q: null, watched: null }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fy, family, service, q, watchedOnly, params],
  );

  return <DefenseBudgetContext.Provider value={value}>{children}</DefenseBudgetContext.Provider>;
}

export function DefenseBudgetContextBar() {
  const ctx = useDefenseBudgetContext();
  const scopeFamily = familyById(ctx.family).label;

  return (
    <div className="pe-v2-card defense-budget-ctxbar" role="group" aria-label="Defense Budget context">
      <div className="defense-budget-ctxbar__row">
        <span className="pe-ws-seg" role="group" aria-label="Fiscal year">
          {ctx.fyOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={option === ctx.fy ? 'active' : ''}
              aria-pressed={option === ctx.fy}
              onClick={() => ctx.setFy(option)}
            >
              {option}
            </button>
          ))}
        </span>
        <FilterControl
          label="Family"
          value={scopeFamily}
          options={DEFENSE_BUDGET_FAMILIES.map((f) => f.label)}
          onChange={(label) => {
            const found = DEFENSE_BUDGET_FAMILIES.find((f) => f.label === label);
            ctx.setFamily(found?.id ?? 'All');
          }}
        />
        <FilterControl
          label="Service"
          value={ctx.service}
          options={[...DEFENSE_BUDGET_SERVICE_OPTIONS]}
          onChange={ctx.setService}
        />
        <span className="defense-budget-ctxbar__search">
          <CapiroInput
            label="Search"
            value={ctx.q}
            onChange={(event) => ctx.setQ(event.target.value)}
            placeholder="Search clients, issues, programs"
            aria-label="Search clients, issues, programs"
          />
        </span>
        <label className="defense-budget-ctxbar__watch">
          <input
            type="checkbox"
            checked={ctx.watchedOnly}
            onChange={(event) => ctx.setWatchedOnly(event.target.checked)}
          />
          Watched only
        </label>
        {ctx.activeFilterCount > 0 ? (
          <CapiroButton size="compact" variant="quiet" onClick={ctx.reset}>
            Reset · {ctx.activeFilterCount}
          </CapiroButton>
        ) : null}
      </div>
      <div className="pe-ws-cap defense-budget-ctxbar__scope">
        {scopeFamily === 'All'
          ? `${ctx.fy} · all budget families · lines show their own latest asserted position`
          : `${ctx.fy} · ${scopeFamily} only · lines show their own latest asserted position`}
      </div>
    </div>
  );
}
