import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DefenseSearchLaneDto, DefenseSearchMatchDto } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { searchDefenseBudget } from './defense-research-api.js';
import './defense-research.css';

function resultHref(item: DefenseSearchMatchDto): string | null {
  return item.subject.type === 'program_element'
    ? `/program-elements/${encodeURIComponent(item.subject.id)}`
    : null;
}

function SearchLane({ title, lane }: { title: string; lane: DefenseSearchLaneDto }) {
  return (
    <section className="dr-search-lane" aria-label={`${title} results`}>
      <div className="dr-search-lane__head">
        <h3>{title}</h3>
        <span className={`dr-lane-state dr-lane-state--${lane.status}`}>{lane.status}</span>
      </div>
      {lane.reason ? <p className="dr-search-reason">{lane.reason}</p> : null}
      {lane.items.map((item) => {
        const href = resultHref(item);
        return (
          <article key={`${item.subject.type}:${item.subject.id}`} className="dr-search-result">
            <div>
              {href ? <a href={href}>{item.subject.label}</a> : <strong>{item.subject.label}</strong>}
              <span>{item.subject.type.replaceAll('_', ' ')} · {item.matchKind.replaceAll('_', ' ')}</span>
              {item.secondaryLabel ? <small>{item.secondaryLabel}</small> : null}
            </div>
            <p>{item.explanation.rationale}</p>
            <div className="dr-search-evidence">
              <span>{item.availability}</span>
              {item.evidence.map((evidence, index) => evidence.sourceUrl ? (
                <a key={evidence.evidenceRefId} href={evidence.sourceUrl} target="_blank" rel="noreferrer">
                  Source {index + 1}
                </a>
              ) : <span key={evidence.evidenceRefId}>Source locator unavailable</span>)}
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function DefenseResearchSearchPanel() {
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [semanticEnabled, setSemanticEnabled] = useState(false);
  const search = useQuery({
    queryKey: ['defense-research-search', query, semanticEnabled],
    queryFn: () => searchDefenseBudget(api, { q: query, semanticEnabled }),
    enabled: query.length >= 2,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next.length >= 2) setQuery(next);
  };

  return (
    <section className="pe-v2-card dr-search" aria-label="Defense research search">
      <div className="dr-search__head">
        <div>
          <h2>Research search</h2>
          <p>Exact identities and governed capability matches stay available independently of semantic search.</p>
        </div>
        <nav className="dr-page-nav" aria-label="Research tools">
          <a href="/program-elements/research">Research</a>
          <a href="/program-elements/compare">Compare</a>
          <a href="/program-elements/coverage">Coverage</a>
        </nav>
      </div>
      <form className="dr-search-form" onSubmit={submit}>
        <label>
          Program, PE, project, budget line, office, acquisition, or document
          <input value={draft} minLength={2} maxLength={200} onChange={(event) => setDraft(event.target.value)} placeholder="Search exact names, identifiers, aliases, or capabilities" />
        </label>
        <label className="dr-search-toggle">
          <input type="checkbox" checked={semanticEnabled} onChange={(event) => setSemanticEnabled(event.target.checked)} />
          Enable semantic lane
        </label>
        <button type="submit" disabled={draft.trim().length < 2}>Search</button>
      </form>
      {search.isPending && query ? <p role="status">Searching qualified research sources…</p> : null}
      {search.isError ? <p role="alert">Research search could not be loaded.</p> : null}
      {search.data ? (
        <>
          <div className="dr-query-expansion">
            <strong>Query expansion</strong>
            <span>{search.data.expansion.applied ? search.data.expansion.terms.join(' · ') : 'No controlled expansion applied'}</span>
            <small>Negative controls: {search.data.expansion.excludedTerms.join(', ')}</small>
          </div>
          <div className="dr-search-lanes">
            <SearchLane title="Exact / alias" lane={search.data.exact} />
            <SearchLane title="Capability" lane={search.data.capability} />
            <SearchLane title="Semantic" lane={search.data.semantic} />
          </div>
        </>
      ) : null}
    </section>
  );
}
