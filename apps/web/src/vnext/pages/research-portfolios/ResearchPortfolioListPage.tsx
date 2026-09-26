import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ResearchPortfolioMode } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  createResearchPortfolio,
  listResearchPortfolios,
  researchPortfolioKeys,
} from './research-portfolios-api.js';

export function ResearchPortfolioListPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [mode, setMode] = useState<ResearchPortfolioMode>('manual');
  const [showCreate, setShowCreate] = useState(false);

  const query = useQuery({
    queryKey: researchPortfolioKeys.all,
    queryFn: () => listResearchPortfolios(api),
  });
  const create = useMutation({
    mutationFn: () => createResearchPortfolio(api, { name: name.trim(), purpose: purpose.trim() || null, mode }),
    onSuccess: async (receipt) => {
      await queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.all });
      navigate(`/research-portfolios/${receipt.portfolioId}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <main className="rp-page" data-testid="research-portfolios-list">
      <header className="rp-page__header">
        <div>
          <p className="rp-eyebrow">Portfolio</p>
          <h1>Research Portfolios</h1>
          <p>Curate durable defense research collections without changing the underlying budget records.</p>
        </div>
        <button className="rp-button rp-button--primary" type="button" onClick={() => setShowCreate((open) => !open)}>
          {showCreate ? 'Cancel' : 'New portfolio'}
        </button>
      </header>

      {showCreate ? (
        <form className="rp-card rp-form" onSubmit={submit} aria-label="Create research portfolio">
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
          </label>
          <label>
            Purpose
            <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={3} maxLength={2000} />
          </label>
          <label>
            Collection mode
            <select value={mode} onChange={(event) => setMode(event.target.value as ResearchPortfolioMode)}>
              <option value="manual">Manual</option>
              <option value="rules">Rules</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </label>
          {create.error ? <p className="rp-error" role="alert">Unable to create the portfolio. Try again.</p> : null}
          <button className="rp-button rp-button--primary" disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Creating…' : 'Create portfolio'}
          </button>
        </form>
      ) : null}

      {query.isLoading ? <p className="rp-state">Loading research portfolios…</p> : null}
      {query.error ? <p className="rp-error" role="alert">Research portfolios could not be loaded.</p> : null}
      {query.data?.items.length === 0 ? (
        <section className="rp-card rp-empty">
          <h2>No research portfolios yet</h2>
          <p>Create a manual collection, then add programs, program elements, projects, budget lines, or awards.</p>
        </section>
      ) : null}
      <section className="rp-grid" aria-label="Research portfolio results">
        {query.data?.items.map((portfolio) => (
          <Link className="rp-card rp-portfolio-card" to={`/research-portfolios/${portfolio.id}`} key={portfolio.id}>
            <div className="rp-row rp-row--spread">
              <h2>{portfolio.name}</h2>
              <span className={`rp-badge rp-badge--${portfolio.lifecycle}`}>{portfolio.lifecycle}</span>
            </div>
            <p>{portfolio.purpose || 'No purpose recorded.'}</p>
            <dl className="rp-metrics">
              <div><dt>Members</dt><dd>{portfolio.memberCount}</dd></div>
              <div><dt>Clients</dt><dd>{portfolio.clientLinkCount}</dd></div>
              <div><dt>Role</dt><dd>{portfolio.myRole}</dd></div>
              <div><dt>Mode</dt><dd>{portfolio.mode}</dd></div>
            </dl>
          </Link>
        ))}
      </section>
    </main>
  );
}
