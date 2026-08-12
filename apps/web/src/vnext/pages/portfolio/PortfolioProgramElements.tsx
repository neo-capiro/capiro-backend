import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getProgramElementsList } from '../../../pages/program-element/api.js';
import type { ProgramElementListItem } from '../../../pages/program-element/types.js';
import { CapiroButton } from '../../components/actions/index.js';

/**
 * Portfolio-wide Program elements (PORTFOLIO-HANDOFF §7.1.2).
 *
 * Cards reuse the client-level vocabulary — PE code, program name, the
 * PB → Auth → Approp progression and a delta chip — so the two surfaces read as
 * one system. Figures come from the program-element service; the CRM never
 * recomputes a delta. A stage with no figure renders `—`, never `$0`, and the
 * delta chip is suppressed rather than computed from a gap (§7.1.2 Rules).
 *
 * The cross-client attribution and net-portfolio delta the design shows have no
 * portfolio-scoped endpoint (the watch list is per-PE, not joined to clients) —
 * logged as GAP G2. The cards render the real per-PE budget figures and link to
 * the program-element detail; the attribution footer is omitted rather than
 * faked.
 */

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 1,
  notation: 'compact',
});

function formatMillions(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${CURRENCY.format(value)}M`;
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

function PeCard({ pe }: { pe: ProgramElementListItem }) {
  const navigate = useNavigate();
  const delta = pe.deltaPct;
  const hasDelta = delta != null && Number.isFinite(delta);
  const down = hasDelta && (delta as number) < 0;

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
        <span className="capiro-portfolio-pe__arrow" aria-hidden>
          →
        </span>
        {stage(pe.latestCurrent ?? pe.latestEnacted, 'Auth')}
        <span className="capiro-portfolio-pe__arrow" aria-hidden>
          →
        </span>
        {stage(pe.latestEnacted, 'Approp')}
      </div>
      <div className="capiro-portfolio-pe__foot">
        <span className="capiro-portfolio-pe__service">{pe.service ?? 'Service unrecorded'}</span>
        {hasDelta ? (
          <span
            className={`capiro-portfolio-pe__delta ${
              down ? 'capiro-portfolio-pe__delta--down' : 'capiro-portfolio-pe__delta--up'
            }`}
          >
            {down ? '▼' : '▲'} {Math.abs(delta as number).toFixed(1)}%
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function PortfolioProgramElements() {
  const api = useApi();
  const navigate = useNavigate();
  const monitored = useQuery({
    queryKey: ['program-element-finder', 'portfolio-watch'],
    queryFn: () => getProgramElementsList(api, { watched: 'true', limit: 100 }),
    staleTime: 30_000,
  });

  const rows = monitored.data?.data ?? [];
  const total = monitored.data?.total ?? rows.length;

  return (
    <section
      className="capiro-portfolio-pe"
      aria-labelledby="capiro-portfolio-pe-title"
      id="portfolio-program-elements"
    >
      <div className="capiro-portfolio-pe__header">
        <div className="capiro-portfolio-pe__title-row">
          <h2 className="capiro-portfolio-pe__title" id="capiro-portfolio-pe-title">
            Program elements
          </h2>
          <span className="capiro-portfolio-pe__count">{total.toLocaleString()}</span>
        </div>
        <p className="capiro-portfolio-pe__sub">
          Defense budget lines funding client programs, across the portfolio.
        </p>
        <span className="capiro-portfolio-pe__header-spacer" />
        <CapiroButton variant="quiet" size="compact" onClick={() => navigate('/program-elements')}>
          Open budget
        </CapiroButton>
      </div>

      {monitored.isLoading ? (
        <div className="capiro-portfolio-pe__grid" aria-hidden>
          <div className="capiro-portfolio-pe__skeleton" style={{ height: 148 }} />
          <div className="capiro-portfolio-pe__skeleton" style={{ height: 148 }} />
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
            <PeCard key={pe.peCode} pe={pe} />
          ))}
        </div>
      )}
    </section>
  );
}
