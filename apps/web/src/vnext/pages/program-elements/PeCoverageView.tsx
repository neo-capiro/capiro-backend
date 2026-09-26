import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import type { DefenseProductCoverageRowDto } from '@capiro/shared';
import { getDefenseProductCoverage, type DefenseProductCoverageFilters } from './defense-research-api.js';
import './defense-research.css';

function CoverageFilters({
  filters,
  onChange,
}: {
  filters: DefenseProductCoverageFilters;
  onChange: (filters: DefenseProductCoverageFilters) => void;
}) {
  return (
    <form className="dr-filters-grid" onSubmit={(e) => e.preventDefault()}>
      <label>
        Perimeter
        <input
          value={filters.perimeter ?? ''}
          onChange={(e) => onChange({ ...filters, perimeter: e.target.value || undefined })}
          placeholder="e.g., appropriations"
        />
      </label>

      <label>
        Component
        <input
          value={filters.component ?? ''}
          onChange={(e) => onChange({ ...filters, component: e.target.value || undefined })}
          placeholder="e.g., ARMY"
        />
      </label>

      <label>
        Account
        <input
          type="text"
          value={filters.account ?? ''}
          onChange={(e) => onChange({ ...filters, account: e.target.value || undefined })}
          placeholder="e.g., BA-1"
        />
      </label>

      <label>
        Family
        <input
          type="text"
          value={filters.family ?? ''}
          onChange={(e) => onChange({ ...filters, family: e.target.value || undefined })}
          placeholder="e.g., Aircraft"
        />
      </label>

      <label>
        Fiscal Year
        <input
          type="number"
          min={1900}
          max={2200}
          value={filters.fiscalYear ?? ''}
          onChange={(e) =>
            onChange({
              ...filters,
              fiscalYear: e.target.value ? parseInt(e.target.value, 10) : undefined,
            })
          }
          placeholder="YYYY"
        />
      </label>

      <label>
        Edition
        <input
          type="text"
          value={filters.edition ?? ''}
          onChange={(e) => onChange({ ...filters, edition: e.target.value || undefined })}
          placeholder="e.g., PB, CJ, Omnibus"
        />
      </label>

      <label>
        Stage
        <input
          value={filters.stage ?? ''}
          onChange={(e) => onChange({ ...filters, stage: e.target.value || undefined })}
          placeholder="e.g., request"
        />
      </label>

      <label>
        Detail
        <input
          type="text"
          value={filters.detail ?? ''}
          onChange={(e) => onChange({ ...filters, detail: e.target.value || undefined })}
          placeholder="Additional context"
        />
      </label>
    </form>
  );
}

function CoverageRow({ row }: { row: DefenseProductCoverageRowDto }) {
  const percent = (value: number, total: number) => {
    if (total === 0) return '0%';
    return `${Math.round((value / total) * 100)}%`;
  };

  const denominatorKnown = row.denominator.state === 'known' && row.denominator.value !== null;
  const total = denominatorKnown ? row.denominator.value! : null;

  return (
    <tr className="dr-coverage-row">
      <td>{row.perimeter}</td>
      <td>{row.component ?? '—'}</td>
      <td>{row.account ?? '—'}</td>
      <td>{row.family}</td>
      <td>{row.fiscalYear}</td>
      <td>{row.edition ?? '—'}</td>
      <td>{row.stage}</td>
      <td>{row.detail ?? '—'}</td>
      <td>
        {denominatorKnown ? (
          <>
            {total?.toLocaleString()} {row.denominator.unit.replace('_', ' ')}
            <br />
            <small>{row.denominator.reason}</small>
          </>
        ) : (
          <>
            Unknown
            <br />
            <small>{row.denominator.reason}</small>
          </>
        )}
      </td>
      <td>
        {row.discovered}
        {total !== null ? ` (${percent(row.discovered, total)})` : ''}
      </td>
      <td>
        {row.parsed}
        {total !== null ? ` (${percent(row.parsed, total)})` : ''}
      </td>
      <td>
        {row.qualified}
        {total !== null ? ` (${percent(row.qualified, total)})` : ''}
      </td>
      <td>
        {row.published}
        {total !== null ? ` (${percent(row.published, total)})` : ''}
      </td>
      <td className={`dr-outcome-${row.outcome}`}>{row.outcome}</td>
    </tr>
  );
}

export function PeCoverageView() {
  const api = useApi();
  const [params, setParams] = useSearchParams();

  const filters: DefenseProductCoverageFilters = {
    perimeter: params.get('perimeter') ?? undefined,
    component: params.get('component') ?? undefined,
    account: params.get('account') ?? undefined,
    family: params.get('family') ?? undefined,
    fiscalYear: params.get('fiscalYear') ? parseInt(params.get('fiscalYear')!, 10) : undefined,
    edition: params.get('edition') ?? undefined,
    stage: params.get('stage') ?? undefined,
    detail: params.get('detail') ?? undefined,
  };

  const updateFilters = (newFilters: DefenseProductCoverageFilters) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(newFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          next.set(key, String(value));
        } else {
          next.delete(key);
        }
      });
      return next;
    });
  };

  const resetFilters = () => {
    setParams(new URLSearchParams());
  };

  const hasFilters = Object.values(filters).some((v) => v !== undefined && v !== '');

  const coverage = useQuery({
    queryKey: ['defense-product-coverage', filters],
    queryFn: () => getDefenseProductCoverage(api, filters),
  });

  return (
    <main className="dr-page" data-screen-label="Defense product coverage">
      <header className="dr-head">
        <div>
          <p className="dr-eyebrow">Intelligence · Coverage</p>
          <h1>Defense product coverage</h1>
          <p>
            Track known vs. unknown denominators across perimeters, components, accounts, families,
            fiscal years, editions, and stages. Never exposes internal queue IDs or operator ownership.
          </p>
        </div>
        <a href="/program-elements">Back to Intelligence</a>
      </header>

      <section className="dr-section">
        <h2>Filters</h2>
        <CoverageFilters filters={filters} onChange={updateFilters} />
        {hasFilters && (
          <button type="button" className="dr-reset-filters" onClick={resetFilters}>
            Clear all filters
          </button>
        )}
      </section>

      <section className="dr-section">
        <h2>Coverage</h2>
        {coverage.isPending ? (
          <p role="status">Loading coverage data…</p>
        ) : coverage.isError ? (
          <p role="alert">The coverage data could not be loaded.</p>
        ) : coverage.data ? (
          <>
            <div className="dr-coverage-meta">
              <span>Projection version: {coverage.data.projectionVersion}</span>
              <span className={coverage.data.denominatorKnown ? 'dr-known' : 'dr-unknown'}>
                Denominator: {coverage.data.denominatorKnown ? 'Known' : 'Unknown'}
              </span>
              {coverage.data.limitations.length > 0 && (
                <details className="dr-limitations">
                  <summary>Limitations ({coverage.data.limitations.length})</summary>
                  <ul>
                    {coverage.data.limitations.map((limitation, idx) => (
                      <li key={idx}>{limitation}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <div className="dr-coverage-table">
              <table className="dr-table">
                <thead>
                  <tr>
                    <th>Perimeter</th>
                    <th>Component</th>
                    <th>Account</th>
                    <th>Family</th>
                    <th>Fiscal Year</th>
                    <th>Edition</th>
                    <th>Stage</th>
                    <th>Detail</th>
                    <th>Denominator</th>
                    <th>Discovered</th>
                    <th>Parsed</th>
                    <th>Qualified</th>
                    <th>Published</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.data.rows.map((row) => (
                    <CoverageRow key={[row.perimeter, row.component, row.account, row.family, row.fiscalYear, row.edition, row.stage, row.detail].join(':')} row={row} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="dr-coverage-summary">
              <p>
                Showing {coverage.data.rows.length} row
                {coverage.data.rows.length !== 1 ? 's' : ''}.{' '}
                {coverage.data.denominatorKnown
                  ? 'Denominators are known for displayed rows.'
                  : 'Denominators are unknown or partially unknown.'}
              </p>
            </div>
          </>
        ) : null}
      </section>

      <nav className="dr-page-nav">
        <a href="/program-elements/research">Research</a>
        <a href="/program-elements/compare">Compare</a>
      </nav>
    </main>
  );
}
