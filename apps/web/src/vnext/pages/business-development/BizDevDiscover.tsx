/**
 * Business Development Phase 2 — Discover companies (bounded explicit search).
 *
 * Contract notes (backend-04-report + bizdev-dossier.service.ts):
 * - Candidate search is GET /search/candidates with q (2..200), limit (1..25),
 *   offset (0..500). The response is { results, coverage } — no cursor.
 * - agency/issue/geography filters are NOT supported by the backend; the UI
 *   shows no fake filter inputs and reports coverage honestly.
 * - Candidates carry structured whyInspect, UEI/CAGE identifiers and SAFE
 *   markers only; conflict reasons / note bodies never appear.
 * - Search fires ONLY on explicit submit (never while typing or scrolling);
 *   paging uses a stable numeric offset driven by coverage.more.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { formatDateShort } from '../../lib/labels.js';
import {
  applyBizDevRoute,
  BIZDEV_DISCOVER_LIMIT_DEFAULT,
  bizDevDiscoverQuery,
  resolveBizDevRoute,
} from './bizdev-routing.js';
import {
  bizdevErrorMessage,
  bizdevKeys,
  createBizDevProspect,
  searchBizDevCandidates,
  type BizDevCandidate,
} from './bizdev-api.js';

const SEARCH_MIN = 2;

function CandidateMarkers({ candidate }: { candidate: BizDevCandidate }) {
  const m = candidate.marker;
  return (
    <span className="capiro-bizdev__meta-row">
      {m.prospectActive ? (
        <span className="capiro-bizdev__flag capiro-bizdev__flag--saved">Saved prospect</span>
      ) : null}
      {m.prospectDismissed ? (
        <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">Dismissed</span>
      ) : null}
      {m.client ? (
        <span className="capiro-bizdev__flag capiro-bizdev__flag--client">Client</span>
      ) : null}
      {candidate.clientWithoutProspect ? (
        <span className="capiro-bizdev__flag capiro-bizdev__flag--client">
          Client — no prospect yet
        </span>
      ) : null}
      {m.excluded ? (
        <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">Excluded</span>
      ) : null}
      {candidate.markerCoverage === 'partial' ? (
        <span className="capiro-bizdev__meta">Marker coverage: partial read</span>
      ) : null}
    </span>
  );
}

function WhyInspect({ candidate }: { candidate: BizDevCandidate }) {
  const r = candidate.whyInspect;
  if (!r) {
    return <div className="capiro-bizdev__candidate-evidence capiro-bizdev__meta">No ingested records explain this company yet.</div>;
  }
  return (
    <div className="capiro-bizdev__candidate-evidence">
      <span className="capiro-bizdev__candidate-evidence-icon" aria-hidden="true">▤</span>
      <div>
        <span className="capiro-bizdev__candidate-evidence-label">Why inspect · {r.originalSourceName}</span>
        <span className="capiro-bizdev__candidate-evidence-title">Why inspect: {r.title}</span>
        <span className="capiro-bizdev__meta">
          {r.eventDate ? `Event ${formatDateShort(r.eventDate) ?? r.eventDate}` : 'Event date unavailable'}
          {r.fetchedAt ? ` · fetched ${formatDateShort(r.fetchedAt) ?? r.fetchedAt}` : ''}
        </span>
      </div>
    </div>
  );
}

function CandidateRow({
  tenantId,
  candidate,
  onOpenDossier,
}: {
  tenantId: string;
  candidate: BizDevCandidate;
  onOpenDossier: (canonicalEntityId: string) => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Pending double-click suppression (same pattern as Phase 1 convert).
  const [savePending, setSavePending] = useState(false);

  // Existing prospect marker: opening it replaces saving a duplicate.
  const openExisting = () => {
    if (!candidate.prospectId) return;
    setSearchParams(
      applyBizDevRoute(searchParams, { prospectId: candidate.prospectId, status: 'all' }),
    );
  };

  const save = useMutation({
    mutationFn: () =>
      createBizDevProspect(api, {
        canonicalEntityId: candidate.canonicalEntityId,
        displayName: candidate.canonicalName,
      }),
    onSuccess: (prospect) => {
      toast.success(`Prospect “${prospect.displayName}” is ready`);
      void queryClient.invalidateQueries({ queryKey: bizdevKeys.all(tenantId) });
      setSearchParams(
        applyBizDevRoute(searchParams, { prospectId: prospect.id, status: 'all' }),
      );
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
    onSettled: () => setSavePending(false),
  });

  const identifiers = (candidate.identifiers ?? [])
    .map((i) => `${i.type}: ${i.value}`)
    .join(' · ');
  const initials = candidate.canonicalName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  return (
    <li className="capiro-bizdev__candidate">
      <div className="capiro-bizdev__candidate-main">
        <div className="capiro-bizdev__candidate-identity">
          <span className="capiro-bizdev__candidate-avatar" aria-hidden="true">{initials}</span>
          <div>
            <div className="capiro-bizdev__candidate-heading">
              <span className="capiro-bizdev__candidate-name">{candidate.canonicalName}</span>
              {candidate.whyInspect?.relationshipStrength === 'direct' ? (
                <span className="capiro-bizdev__candidate-badge">Direct evidence</span>
              ) : null}
            </div>
            {identifiers ? <span className="capiro-bizdev__meta">{identifiers}</span> : null}
          </div>
        </div>
        <WhyInspect candidate={candidate} />
        <CandidateMarkers candidate={candidate} />
      </div>
      <div className="capiro-bizdev__candidate-actions">
        <CapiroButton size="compact" onClick={() => onOpenDossier(candidate.canonicalEntityId)}>
          Open dossier
        </CapiroButton>
        {candidate.prospectId ? (
          <CapiroButton size="compact" onClick={openExisting}>
            Open existing prospect
          </CapiroButton>
        ) : (
          <CapiroButton
            size="compact"
            variant="primary"
            loading={save.isPending}
            disabled={savePending || save.isPending}
            onClick={() => {
              if (savePending || save.isPending) return;
              setSavePending(true);
              save.mutate();
            }}
          >
            Save prospect
          </CapiroButton>
        )}
      </div>
    </li>
  );
}

export function DiscoverPanel({ tenantId }: { tenantId: string }) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolveBizDevRoute(searchParams);

  // Draft: typing never fetches. Submit writes q to the URL; the query
  // subscribes to URL state only.
  const [draft, setDraft] = useState(route.discoverQuery);
  useEffect(() => {
    setDraft(route.discoverQuery);
  }, [route.discoverQuery]);

  const discoverQuery = bizDevDiscoverQuery(route);
  const search = useQuery({
    queryKey: bizdevKeys.candidates(tenantId, discoverQuery),
    queryFn: () => searchBizDevCandidates(api, discoverQuery),
    enabled: route.discover === 'open' && discoverQuery.q.length >= SEARCH_MIN,
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const q = draft.trim();
    if (q.length < SEARCH_MIN) return;
    setSearchParams(
      applyBizDevRoute(searchParams, { discover: 'open', discoverQuery: q, discoverOffset: 0 }),
    );
  };

  const page = (delta: number) =>
    setSearchParams(
      applyBizDevRoute(searchParams, {
        discoverOffset: Math.max(0, discoverQuery.offset + delta * discoverQuery.limit),
      }),
    );

  const openDossier = (canonicalEntityId: string) =>
    setSearchParams(applyBizDevRoute(searchParams, { dossierEntityId: canonicalEntityId }));

  const coverage = search.data?.coverage;
  const hasQuery = route.discover === 'open' && discoverQuery.q.length >= SEARCH_MIN;

  return (
    <section className="capiro-bizdev__discover" aria-labelledby="bizdev-discover">
      <div className="capiro-bizdev__discover-top">
      <div className="capiro-bizdev__toolbar capiro-bizdev__discover-toolbar">
        <div className="capiro-bizdev__title-row">
          <h2 className="capiro-bizdev__section-title" id="bizdev-discover">
            Discover companies
          </h2>
        </div>
        {route.discover === 'open' ? (
          <CapiroButton
            size="compact"
            onClick={() =>
              setSearchParams(
                applyBizDevRoute(searchParams, {
                  discover: '',
                  discoverQuery: '',
                  discoverOffset: 0,
                }),
                { replace: true },
              )
            }
          >
            Back to pipeline
          </CapiroButton>
        ) : null}
      </div>
      <form className="capiro-bizdev__discover-form" onSubmit={submit}>
        <div className="capiro-bizdev__field capiro-bizdev__discover-q">
          <label className="capiro-bizdev__label" htmlFor="bizdev-discover-q">
            Company search (minimum 2 characters)
          </label>
          <input
            id="bizdev-discover-q"
            className="capiro-bizdev__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
            placeholder="Search companies by name"
          />
        </div>
        <div className="capiro-bizdev__discover-submit">
          <CapiroButton
            variant="primary"
            size="compact"
            type="submit"
            disabled={draft.trim().length < SEARCH_MIN}
          >
            Search companies
          </CapiroButton>
        </div>
      </form>
      <p className="capiro-bizdev__discover-note capiro-bizdev__meta">
        Searches ingested government records by organization name. Results appear only after you
        submit. Agency, issue and geography filters are not available for this search.
      </p>
      </div>

      {hasQuery ? (
        search.isPending ? (
          <div className="capiro-bizdev__section-pad" aria-busy="true">
            <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" />
          </div>
        ) : search.isError ? (
          <div className="capiro-bizdev__section-pad">
            <CapiroErrorState
              title="The company search could not be completed"
              description={bizdevErrorMessage(search.error)}
              onRetry={() => void search.refetch()}
              retryLabel="Retry search"
            />
          </div>
        ) : (search.data?.results ?? []).length === 0 ? (
          <div className="capiro-bizdev__surface capiro-bizdev__section-pad">
            <CapiroEmptyState
              variant="search-empty"
              title="No companies matched this search"
              description="Try a different or longer company name."
            />
          </div>
        ) : (
          <>
            <div className="capiro-bizdev__discover-summary" role="status">
              <strong>{search.data!.results.length} {search.data!.results.length === 1 ? 'company' : 'companies'} shown</strong>
              <span>Ingested government records · {coverage?.more ? 'more results available' : 'end of results'}</span>
            </div>
            <ul className="capiro-bizdev__candidate-list">
              {(search.data?.results ?? []).map((candidate) => (
                <CandidateRow
                  key={candidate.canonicalEntityId}
                  tenantId={tenantId}
                  candidate={candidate}
                  onOpenDossier={openDossier}
                />
              ))}
            </ul>
            <div className="capiro-bizdev__discover-pager">
              <CapiroButton
                size="compact"
                disabled={discoverQuery.offset <= 0}
                onClick={() => page(-1)}
              >
                Previous
              </CapiroButton>
              <span className="capiro-bizdev__meta" role="status">
                {coverage
                  ? `Showing from result ${coverage.offset + 1}${coverage.more ? ' · more results follow' : ' · end of results'}`
                  : `Showing from result ${discoverQuery.offset + 1}`}
              </span>
              <CapiroButton size="compact" disabled={!coverage?.more} onClick={() => page(1)}>
                Next
              </CapiroButton>
            </div>
          </>
        )
      ) : (
        <p className="capiro-bizdev__discover-note capiro-bizdev__meta">
          Enter a company name and submit the search to see candidate companies with their
          source-backed reason for inspection.
        </p>
      )}
    </section>
  );
}
