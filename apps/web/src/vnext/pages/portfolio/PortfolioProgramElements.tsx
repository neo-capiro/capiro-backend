import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementsList } from '../../../pages/program-element/api.js';
import type { ProgramElementListItem } from '../../../pages/program-element/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { formatMoney } from '../../lib/labels.js';
import type { PortfolioPeSummaryResponse } from './usePortfolioIndexModel.js';

/**
 * Portfolio-wide Program elements (PORTFOLIO-HANDOFF §7.1.2).
 *
 * Cards reuse the client-level vocabulary — PE code, program name, the
 * PB → Auth → Approp progression and a delta chip — so the two surfaces read as
 * one system. Figures come from the program-element service; the CRM never
 * recomputes a delta. A stage with no figure renders `—`, never `$0`, and the
 * delta chip is suppressed rather than computed from a gap (§7.1.2 Rules).
 *
 * Item 7 (G2): The header now shows the real net portfolio delta from the
 * portfolio-pe-summary endpoint instead of a hardcoded "— net".
 * Item 8 (G2): Each PE card footer now shows the real client attribution
 * (client names joined from ClientCapability.peNumbers) instead of the
 * "Client attribution unavailable" placeholder.
 */

/**
 * PE stage figures arrive in $M. Scale to raw dollars and let the shared
 * compact-money helper pick the unit — 44.3 → "$44.3M", 1234 → "$1.23B".
 * (The old compact-notation formatter + hardcoded "M" suffix produced
 * "$1.2KM" once a value crossed $1B.)
 */
function formatMillions(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return formatMoney(value * 1e6);
}

function stage(value: number | null | undefined, label: string) {
  const formatted = formatMillions(value);
  return (
    <div className="capiro-portfolio-pe__stage" key={label}>
      <span className="capiro-portfolio-pe__stage-label">{label}</span>
      <span className={`capiro-portfolio-pe__stage-value${formatted ? '' : ' is-missing'}`}>
        {formatted ?? '—'}
      </span>
    </div>
  );
}

function PeCard({
  pe,
  attribution,
}: {
  pe: ProgramElementListItem;
  attribution: string[];
}) {
  const navigate = useNavigate();
  const delta = pe.deltaPct;
  const hasDelta = delta != null && Number.isFinite(delta);
  const down = hasDelta && (delta as number) < 0;

  // Item 8 (G2): real client attribution from portfolio-pe-summary. Falls back
  // to the "unavailable" message when the join returned no clients for this PE.
  const attributionLabel =
    attribution.length > 0
      ? attribution.join(', ')
      : 'Client attribution unavailable';

  return (
    <button
      type="button"
      className="capiro-portfolio-pe__card capiro-elevation-widget"
      onClick={() => navigate(`/program-elements/${encodeURIComponent(pe.peCode)}`)}
      aria-label={`Open program element ${pe.peCode} ${pe.title}`}
    >
      <div className="capiro-portfolio-pe__card-head">
        <span className="capiro-portfolio-pe__code">{pe.peCode}</span>
        <span className="capiro-portfolio-pe__name">{pe.title}</span>
      </div>
      <div className="capiro-portfolio-pe__progression">
        {stage(pe.latestRequest, 'PB')}
        <span className="capiro-portfolio-pe__arrow" aria-hidden>→</span>
        {stage(pe.latestCurrent ?? pe.latestEnacted, 'Auth')}
        <span className="capiro-portfolio-pe__arrow" aria-hidden>→</span>
        {stage(pe.latestEnacted, 'Approp')}
      </div>
      <div className="capiro-portfolio-pe__foot">
        <span
          className="capiro-portfolio-pe__service"
          title={attribution.length > 0 ? attribution.join(', ') : undefined}
        >
          {attributionLabel}
        </span>
        {hasDelta ? (
          <span
            className={`capiro-portfolio-pe__delta ${
              down ? 'capiro-portfolio-pe__delta--down' : 'capiro-portfolio-pe__delta--up'
            }`}
            role="img"
            aria-label={`${down ? 'down' : 'up'} ${Math.abs(delta as number).toFixed(1)} percent`}
          >
            {down ? '▼' : '▲'} {Math.abs(delta as number).toFixed(1)}%
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function PortfolioProgramElements({
  peSummary,
}: {
  peSummary: UseQueryResult<PortfolioPeSummaryResponse>;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const monitored = useQuery({
    queryKey: ['program-element-finder', 'portfolio-watch'],
    queryFn: () => getProgramElementsList(api, { watched: 'true', limit: 100 }),
    staleTime: 30_000,
  });

  const rows = monitored.data?.data ?? [];
  const total = monitored.data?.total ?? rows.length;

  // Item 7 (G2): real net portfolio delta from the PE summary endpoint.
  const netDeltaPct = peSummary.data?.netDeltaPct ?? null;
  const hasNetDelta = netDeltaPct != null && Number.isFinite(netDeltaPct);
  const netDown = hasNetDelta && netDeltaPct < 0;
  const netLabel = hasNetDelta
    ? `${netDown ? '▼' : '▲'} ${Math.abs(netDeltaPct).toFixed(1)}% net`
    : '— net';

  // Item 8 (G2): per-PE client attribution from the PE summary endpoint.
  const peAttribution = peSummary.data?.peAttribution ?? {};

  return (
    <section
      className="capiro-portfolio-pe capiro-portfolio__surface"
      aria-labelledby="capiro-portfolio-pe-title"
      id="portfolio-program-elements"
    >
      <div className="capiro-portfolio-pe__header">
        <div className="capiro-portfolio-pe__title-row">
          <h2 className="capiro-portfolio-pe__title" id="capiro-portfolio-pe-title">
            Program elements
          </h2>
          <span className="capiro-portfolio-pe__count">{total.toLocaleString()} tracked</span>
        </div>
        <p className="capiro-portfolio-pe__sub">
          Defense budget lines funding client programs, across the portfolio.
        </p>
        <span className="capiro-portfolio-pe__header-spacer" />
        {/* Item 7 (G2): real net portfolio delta */}
        <span
          className={`capiro-portfolio-pe__net${
            hasNetDelta
              ? netDown
                ? ' capiro-portfolio-pe__net--down'
                : ' capiro-portfolio-pe__net--up'
              : ''
          }`}
          role={hasNetDelta ? 'img' : undefined}
          aria-label={
            hasNetDelta
              ? `${netDown ? 'down' : 'up'} ${Math.abs(netDeltaPct).toFixed(1)} percent net`
              : undefined
          }
        >
          {netLabel}
        </span>
        <CapiroButton variant="quiet" size="compact" onClick={() => navigate('/program-elements')}>
          Open budget
        </CapiroButton>
      </div>

      {monitored.isLoading ? (
        <div className="capiro-portfolio-pe__grid" aria-hidden>
          <div className="capiro-portfolio-pe__skeleton" />
          <div className="capiro-portfolio-pe__skeleton" />
        </div>
      ) : monitored.isError ? (
        <div className="capiro-portfolio__state capiro-portfolio__state--error" role="status">
          <span>
            Budget programs could not be loaded. The client list above is intact.
            {monitored.error instanceof Error ? ` (${monitored.error.message})` : ''}
          </span>
          <CapiroButton variant="quiet" size="compact" onClick={() => void monitored.refetch()}>
            Retry
          </CapiroButton>
        </div>
      ) : rows.length === 0 ? (
        <div className="capiro-portfolio__state" role="status">
          No program elements are being tracked yet. Open the budget explorer to start watching the
          lines that fund your clients.
        </div>
      ) : (
        <div className="capiro-portfolio-pe__grid">
          {rows.map((pe) => (
            <PeCard
              key={pe.peCode}
              pe={pe}
              attribution={peAttribution[pe.peCode] ?? []}
            />
          ))}
        </div>
      )}
    </section>
  );
}
