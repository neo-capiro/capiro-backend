import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import {
  getDefenseOffice,
  listDefenseOffices,
  listDefenseRelationships,
  type OfficeFilters,
} from './defense-research-api.js';
import './defense-research.css';

type View = 'offices' | 'relationships';

function EvidenceLink({ url, label = 'Source' }: { url: string | null; label?: string }) {
  return url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : <span>Source unavailable</span>;
}

export function PeResearchView() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'relationships' ? 'relationships' : 'offices';
  const selectedOffice = params.get('office');
  const filters: OfficeFilters = {
    q: params.get('q') ?? undefined,
    component: params.get('component') ?? undefined,
    officeType: params.get('officeType') ?? undefined,
    status: params.get('status') ?? undefined,
    availability: params.get('availability') ?? undefined,
    freshness: params.get('freshness') ?? undefined,
    program: params.get('program') ?? undefined,
    capability: params.get('capability') ?? undefined,
    limit: 100,
  };

  const offices = useQuery({
    queryKey: ['defense-research', 'offices', filters],
    queryFn: () => listDefenseOffices(api, filters),
    enabled: view === 'offices',
  });
  const detail = useQuery({
    queryKey: ['defense-research', 'office', selectedOffice],
    queryFn: () => getDefenseOffice(api, selectedOffice!),
    enabled: view === 'offices' && Boolean(selectedOffice),
  });
  const relationships = useQuery({
    queryKey: ['defense-research', 'relationships', params.get('edgeType')],
    queryFn: () => listDefenseRelationships(api, {
      edgeType: params.get('edgeType') ?? undefined,
      status: params.get('relationshipStatus') ?? undefined,
      includeSpeculative: false,
      limit: 200,
    }),
    enabled: view === 'relationships',
  });

  const update = (key: string, value: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  };

  return (
    <main className="dr-page" data-screen-label="Defense research">
      <header className="dr-head">
        <div>
          <p className="dr-eyebrow">Intelligence · Research</p>
          <h1>Defense relationships</h1>
          <p>Trace sourced offices, roles, programs, and acquisition paths without inferring allocations.</p>
        </div>
        <a href="/program-elements">Back to Intelligence</a>
      </header>

      <nav className="dr-tabs" aria-label="Defense research views">
        {(['offices', 'relationships'] as const).map((item) => (
          <button key={item} className={view === item ? 'is-active' : ''} type="button" onClick={() => update('view', item)}>
            {item === 'offices' ? 'Offices / PMOs / PEOs' : 'Relationship ledger'}
          </button>
        ))}
      </nav>

      {view === 'offices' ? (
        <>
          <form className="dr-filters" onSubmit={(event) => event.preventDefault()} aria-label="Office filters">
            <label>Search<input value={params.get('q') ?? ''} onChange={(event) => update('q', event.target.value)} /></label>
            <label>Component<input value={params.get('component') ?? ''} onChange={(event) => update('component', event.target.value)} /></label>
            <label>Office type<select value={params.get('officeType') ?? ''} onChange={(event) => update('officeType', event.target.value)}><option value="">All</option><option value="peo">PEO</option><option value="pm">PM</option><option value="contracting_office">Contracting office</option><option value="other">Other</option></select></label>
            <label>Status<select value={params.get('status') ?? ''} onChange={(event) => update('status', event.target.value)}><option value="">All</option><option value="active">Active</option><option value="historical">Historical</option><option value="superseded">Superseded</option><option value="unresolved">Unresolved</option></select></label>
            <label>Evidence<select value={params.get('availability') ?? ''} onChange={(event) => update('availability', event.target.value)}><option value="">Any</option><option value="available">Available</option><option value="partial">Partial</option><option value="unavailable">Unavailable</option></select></label>
          </form>
          {offices.isPending ? <p role="status">Loading offices…</p> : null}
          {offices.isError ? <p role="alert">The office directory could not be loaded.</p> : null}
          {offices.data?.items.length === 0 ? <p>No offices match these filters.</p> : null}
          <div className="dr-layout">
            <section className="dr-list" aria-label="Office directory">
              {offices.data?.items.map((office) => (
                <button type="button" key={office.id} className={selectedOffice === office.id ? 'is-selected' : ''} onClick={() => update('office', office.id)}>
                  <strong>{office.name}</strong>
                  <span>{office.officeType.toUpperCase()} · {office.service ?? 'Component unavailable'}</span>
                  <small>{office.status} · {office.availability} evidence</small>
                </button>
              ))}
            </section>
            <aside className="dr-detail" aria-label="Office detail">
              {!selectedOffice ? <p>Select an office to inspect its evidence and effective dates.</p> : null}
              {detail.isPending && selectedOffice ? <p role="status">Loading office detail…</p> : null}
              {detail.isError ? <p role="alert">The office detail could not be loaded.</p> : null}
              {detail.data ? <>
                <h2>{detail.data.name}</h2>
                <p>{detail.data.mission ?? 'Mission unavailable from qualified sources.'}</p>
                <dl><dt>Effective</dt><dd>{detail.data.effectiveStart ?? 'unknown'} – {detail.data.effectiveEnd ?? 'present/unknown'}</dd><dt>Review</dt><dd>{detail.data.reviewStatus ?? 'unreviewed'}</dd><dt>Evidence</dt><dd><EvidenceLink url={detail.data.sourceUrl} /></dd></dl>
                <h3>Program relationships</h3>
                {detail.data.programs.length ? <ul>{detail.data.programs.map((program) => <li key={`${program.programId}:${program.relation}`}><strong>{program.programName}</strong> · {program.relation} · <EvidenceLink url={program.sourceUrl} /></li>)}</ul> : <p>No accepted program relationships.</p>}
                <h3>Leadership</h3>
                {detail.data.leadership.length ? <ul>{detail.data.leadership.map((role) => <li key={`${role.personId}:${role.roleTitle}`}><strong>{role.personName}</strong> · {role.roleTitle} · {role.effectiveStart ?? 'start unknown'}–{role.effectiveEnd ?? 'current/unknown'} · <EvidenceLink url={role.sourceUrl} /></li>)}</ul> : <p>No accepted sourced roles.</p>}
              </> : null}
            </aside>
          </div>
        </>
      ) : (
        <section>
          <div className="dr-filters">
            <label>Relationship<select value={params.get('edgeType') ?? ''} onChange={(event) => update('edgeType', event.target.value)}><option value="">All supported</option><option value="manages">Manages</option><option value="executes">Executes</option><option value="supports">Supports</option><option value="holds_role">Holds role</option><option value="acquisition_path">Acquisition path</option></select></label>
          </div>
          <p className="dr-notice">Candidate/speculative enrichment is disabled. Associations are never presented as funding allocations or contract awards.</p>
          {relationships.isPending ? <p role="status">Loading relationships…</p> : null}
          {relationships.isError ? <p role="alert">The relationship ledger could not be loaded.</p> : null}
          {relationships.data?.items.length === 0 ? <p>No accepted relationships match this view.</p> : null}
          <div className="dr-ledger">
            {relationships.data?.items.map((edge) => <article key={edge.id}>
              <div><strong>{edge.from.label}</strong> <span>{edge.relation.replace('_', ' ')}</span> <strong>{edge.to.label}</strong></div>
              <small>{edge.validity} · observed {edge.observationRevision ?? 'unknown'} · {edge.sourceStated ? 'source-stated' : edge.derived ? 'derived' : 'unresolved'}</small>
              {edge.evidence.length ? <EvidenceLink url={edge.evidence[0]?.sourceUrl ?? null} label="Open evidence" /> : <span>Evidence unavailable</span>}
            </article>)}
          </div>
        </section>
      )}
    </main>
  );
}
