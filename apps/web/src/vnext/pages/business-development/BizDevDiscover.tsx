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
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { formatDateShort } from '../../lib/labels.js';
import {
  applyBizDevRoute,
  BIZDEV_STAGE_LABELS,
  type BizDevStage,
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

/** An award's calendar date must not move back a day in US time zones. */
export function candidateEventDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime())) {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
    }
  }
  return formatDateShort(value) ?? value;
}

/** Compact display is rounded; the accessible exact value preserves decimal cents. */
export function candidateAmount(value: string | null | undefined): { compact: string; exact: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match || !Number.isFinite(Number(value))) return null;
  const whole = match[2]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const exact = `${match[1]}$${whole}.${(match[3] ?? '').padEnd(2, '0')}`;
  return {
    compact: new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
    }).format(Number(value)),
    exact,
  };
}

function stageLabel(stage: string | null | undefined): string {
  return stage && Object.prototype.hasOwnProperty.call(BIZDEV_STAGE_LABELS, stage)
    ? BIZDEV_STAGE_LABELS[stage as BizDevStage]
    : 'Stage not supplied';
}

function evidenceGap(candidate: BizDevCandidate): string {
  switch (candidate.evidenceCoverage) {
    case 'error': return 'Award records could not be checked. Retry the search or inspect the company dossier.';
    case 'empty_in_queried_scope': return 'No exact-UEI award records in the ingested scope. This is not a claim that the company has no awards.';
    case 'identity_unresolved': return 'An exact UEI is needed to verify award evidence for this company.';
    default: return 'No source-backed award reason is available in this search. Open the dossier to review identity and coverage.';
  }
}

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
    return <div className="capiro-bizdev__candidate-evidence capiro-bizdev__meta">{evidenceGap(candidate)}</div>;
  }
  const amount = candidateAmount(r.latestAward?.obligatedAmountUsd);
  return (
    <div className="capiro-bizdev__candidate-evidence">
      <span className="capiro-bizdev__candidate-evidence-icon" aria-hidden="true">▤</span>
      <div>
        <span className="capiro-bizdev__candidate-evidence-label">Why now · Award <span>
          {r.eventDate ? `Event ${candidateEventDate(r.eventDate)}` : 'Event date unavailable'}
          {` · ${r.originalSourceName}`}
        </span></span>
        {amount ? <div className="capiro-bizdev__candidate-amount">
          <strong title={amount.exact} aria-label={amount.exact}>{amount.compact}</strong>
          <span>obligated · latest matched award</span>
        </div> : null}
        {r.latestAward ? (
          <span className="capiro-bizdev__candidate-evidence-title">
            {r.latestAward.description || `Award ${r.recordId}`}
          </span>
        ) : (
          <span className="capiro-bizdev__candidate-evidence-title">Why inspect: {r.title}</span>
        )}
        {r.latestAward ? <details className="capiro-bizdev__candidate-scope">
          <summary>All matched award records</summary><p>{r.title}</p>
        </details> : null}
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
  const saveInFlight = useRef(false);
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
    onSettled: () => { saveInFlight.current = false; setSavePending(false); },
  });

  const identifiers = (candidate.identifiers ?? [])
    .map((i) => `${i.type}: ${i.value}`)
    .join(' · ');
  const initials = candidate.canonicalName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const reason = candidate.whyInspect;
  const award = reason?.latestAward;
  const relationship = candidate.markerCoverage === 'partial' ? 'Relationship check incomplete'
    : candidate.marker.client ? 'Current client'
      : candidate.marker.prospectDismissed ? 'Dismissed prospect'
        : candidate.marker.prospectActive ? `Prospect · ${stageLabel(candidate.stage)}`
          : 'No saved relationship';

  return (
    <li className="capiro-bizdev__candidate" data-canonical-entity-id={candidate.canonicalEntityId}>
      <div className="capiro-bizdev__candidate-main">
        <div className="capiro-bizdev__candidate-identity">
          <span className="capiro-bizdev__candidate-avatar" aria-hidden="true">{initials}</span>
          <div>
            <div className="capiro-bizdev__candidate-heading">
              <span className="capiro-bizdev__candidate-name">{candidate.canonicalName}</span>
              <span className="capiro-bizdev__candidate-badge">
                {reason?.relationshipStrength === 'direct' ? 'Direct evidence' : 'Needs review'}
              </span>
              <CandidateMarkers candidate={candidate} />
            </div>
            {identifiers ? <span className="capiro-bizdev__meta">{identifiers}</span> : null}
          </div>
        </div>
        <WhyInspect candidate={candidate} />
        <dl className="capiro-bizdev__candidate-facts">
          <div><dt>Service hypothesis</dt><dd>{candidate.serviceHypothesis || 'Not assessed'}</dd></div>
          <div><dt>Relationship</dt><dd>{relationship}</dd></div>
          <div><dt>Awarding agency</dt><dd>{award?.awardingAgency || 'Not supplied'}</dd></div>
        </dl>
        <div className="capiro-bizdev__candidate-reasons">
          <span>Appears because</span>
          <ul>
            <li>Company name, alias or identifier matches this search</li>
            {reason ? <li>Named recipient on an exact-UEI award record</li> : null}
            {candidate.marker.client ? <li>Current client of your firm</li> : null}
            {candidate.serviceHypothesis ? <li>Service hypothesis saved by your firm</li> : null}
          </ul>
        </div>
        <div className="capiro-bizdev__candidate-sources">
          <span>Sources</span>
          {reason ? <span className="capiro-bizdev__candidate-source">
            <span aria-hidden="true" className="capiro-bizdev__source-dot" />
            {reason.originalSourceName} · {reason.fetchedAt
              ? `checked ${formatDateShort(reason.fetchedAt) ?? reason.fetchedAt}` : 'check time not supplied'}
          </span> : <span>Award coverage {candidate.evidenceCoverage === 'error' ? 'unavailable' : 'not confirmed'}</span>}
          {award?.recipientState ? <span>Recipient address state: {award.recipientState} · not a verified facility</span> : null}
        </div>
      </div>
      <div className="capiro-bizdev__candidate-actions">
        {candidate.prospectId ? (
          <CapiroButton size="compact" aria-label="Open existing prospect" onClick={openExisting}>
            {candidate.marker.prospectDismissed ? 'Dismissed prospect' : candidate.marker.client ? 'Client prospect' : `In pipeline · ${stageLabel(candidate.stage)}`}
          </CapiroButton>
        ) : (
          <CapiroButton
            size="compact"
            aria-label="Save prospect"
            loading={save.isPending}
            disabled={savePending || save.isPending}
            onClick={() => {
              if (saveInFlight.current) return;
              saveInFlight.current = true;
              setSavePending(true);
              save.mutate();
            }}
          >
            Save to pipeline
          </CapiroButton>
        )}
        <CapiroButton size="compact" aria-label="Open dossier" onClick={() => onOpenDossier(candidate.canonicalEntityId)}>
          Open company <span aria-hidden="true">→</span>
        </CapiroButton>
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
  const candidates = search.data?.results ?? [];
  const directCount = candidates.filter((c) => c.whyInspect?.relationshipStrength === 'direct').length;
  const reviewCount = candidates.length - directCount;

  return (
    <section className="capiro-bizdev__discover" aria-labelledby="bizdev-discover">
      <div className="capiro-bizdev__discover-top">
          <h2 className="capiro-bizdev__sr-only" id="bizdev-discover">
            Discover companies
          </h2>
      <form className="capiro-bizdev__discover-form" onSubmit={submit}>
        <div className="capiro-bizdev__field capiro-bizdev__discover-q">
          <label className="capiro-bizdev__sr-only" htmlFor="bizdev-discover-q">
            Company search (minimum 2 characters)
          </label>
          <input
            id="bizdev-discover-q"
            className="capiro-bizdev__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
            placeholder="Search companies by name or UEI"
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
            <div className="capiro-bizdev__discover-evidence-summary" aria-label="Evidence coverage on this result page">
              <div className="capiro-bizdev__evidence-meter" aria-hidden="true">
                <span style={{ flex: directCount }} /><span style={{ flex: reviewCount }} />
              </div>
              <span><i className="capiro-bizdev__source-dot" aria-hidden="true" />Direct evidence <strong>{directCount}</strong></span>
              <span><i className="capiro-bizdev__source-dot capiro-bizdev__source-dot--review" aria-hidden="true" />Needs review <strong>{reviewCount}</strong></span>
            </div>
            <div className="capiro-bizdev__discover-summary" role="status">
              <strong>{search.data!.results.length} {search.data!.results.length === 1 ? 'company' : 'companies'} shown</strong>
              <span>Name-ordered, exact-identifier evidence · {coverage?.more ? 'more results available' : 'end of results'}</span>
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
          Enter a company name or UEI and submit to search existing Capiro records. No people or paid-provider lookups run on this list. Agency, issue and geography filters are not yet available here.
        </p>
      )}
    </section>
  );
}
