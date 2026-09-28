import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ResearchPortfolioMode } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { useImpersonation } from '../../../state/impersonation.js';
import {
  createResearchPortfolio,
  listResearchPortfolios,
  newIdempotencyKey,
  researchPortfolioKeys,
} from './research-portfolios-api.js';

interface Draft {
  name: string;
  purpose: string;
  mode: ResearchPortfolioMode;
  step: 1 | 2 | 3;
  attempt: {
    key: string;
    uncertain?: boolean;
    payload: {
      name: string;
      purpose: string | null;
      mode: ResearchPortfolioMode;
    };
  } | null;
}
const blankDraft = (): Draft => ({
  name: '',
  purpose: '',
  mode: 'manual',
  step: 1,
  attempt: null,
});
function readDraft(key: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      saved &&
      typeof saved.name === 'string' &&
      typeof saved.purpose === 'string' &&
      ['manual', 'rules', 'hybrid'].includes(saved.mode) &&
      [1, 2, 3].includes(saved.step)
    ) {
      if (
        saved.attempt &&
        (typeof saved.attempt.key !== 'string' ||
          !saved.attempt.payload ||
          JSON.stringify(saved.attempt.payload) !==
            JSON.stringify({
              name: saved.name.trim(),
              purpose: saved.purpose.trim() || null,
              mode: saved.mode,
            }))
      )
        return blankDraft();
      return { ...saved, attempt: saved.attempt ? { ...saved.attempt, uncertain: true } : null };
    }
  } catch {}
  return blankDraft();
}

// Key the whole stateful surface to authenticated authority so a switched actor,
// organization or impersonated tenant cannot view/retry another scope's draft.
export function ResearchPortfolioListPage() {
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  if (!userId)
    return (
      <main className="rp-page">
        <p>Loading research portfolios…</p>
      </main>
    );
  const scope = JSON.stringify([userId, orgId, actAsTenantSlug ?? null]);
  return <ResearchPortfolioListContent key={scope} scope={scope} />;
}

function ResearchPortfolioListContent({ scope }: { scope: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const storageKey = `capiro:research-portfolio-create:v1:${scope}`;
  const [draft, setDraft] = useState(() => readDraft(storageKey));
  const [showCreate, setShowCreate] = useState(() =>
    Boolean(draft.name || draft.purpose || draft.attempt),
  );
  const [storageError, setStorageError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [draft, storageKey]);
  const query = useInfiniteQuery({
    queryKey: [...researchPortfolioKeys.all, 'list', scope],
    queryFn: ({ pageParam }) => listResearchPortfolios(api, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = [
    ...new Map(
      query.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? [],
    ).values(),
  ];
  const create = useMutation({
    mutationFn: (attempt: NonNullable<Draft['attempt']>) =>
      createResearchPortfolio(api, attempt.payload, attempt.key),
    onSuccess: (receipt) => {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      if (!mounted.current) return;
      setDraft(blankDraft());
      setShowCreate(false);
      void queryClient.invalidateQueries({
        queryKey: researchPortfolioKeys.all,
      });
      navigate(`/research-portfolios/${receipt.portfolioId}`);
    },
    onError: (error: unknown) => {
      if (!mounted.current) return;
      // Only an explicit request rejection unlocks edited intent. Network/server
      // errors keep the original payload/key because the write may have committed.
      const status = (error as { response?: { status?: number } }).response?.status;
      setDraft((current) => {
        if (!current.attempt) return current;
        // A later rejection cannot disprove an earlier uncertain commit.
        const rejected =
          !current.attempt.uncertain &&
          status &&
          status >= 400 &&
          status < 500 &&
          ![408, 429].includes(status);
        return rejected
          ? { ...current, attempt: null }
          : { ...current, attempt: { ...current.attempt, uncertain: true } };
      });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending || !draft.name.trim() || storageError) return;
    if (draft.step < 3 && !draft.attempt) {
      setDraft((current) => ({ ...current, step: current.step === 1 ? 2 : 3 }));
      return;
    }
    const attempt = draft.attempt ?? {
      key: newIdempotencyKey('create'),
      uncertain: false,
      payload: {
        name: draft.name.trim(),
        purpose: draft.purpose.trim() || null,
        mode: draft.mode,
      },
    };
    const lockedDraft = { ...draft, step: 3 as const, attempt };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(lockedDraft));
    } catch {
      setStorageError(true);
      return;
    }
    setDraft(lockedDraft);
    create.mutate(attempt);
  }
  return (
    <main className="rp-page" data-testid="research-portfolios-list">
      <header className="rp-page__header">
        <div>
          <p className="rp-eyebrow">Portfolio</p>
          <h1>Research Portfolios</h1>
          <p>
            Curate durable defense research collections without changing the underlying budget
            records.
          </p>
        </div>
        <button
          className="rp-button rp-button--primary"
          type="button"
          onClick={() => setShowCreate((open) => !open)}
        >
          {showCreate
            ? 'Close draft'
            : draft.name || draft.attempt
              ? 'Resume draft'
              : 'New portfolio'}
        </button>
      </header>
      {showCreate ? (
        <form className="rp-card rp-form" onSubmit={submit} aria-label="Create research portfolio">
          <p role="status">
            Step {draft.step} of 3 ·{' '}
            {draft.step === 1 ? 'Purpose' : draft.step === 2 ? 'Collection mode' : 'Preview'}
          </p>
          {draft.step === 1 ? (
            <>
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  required
                  maxLength={160}
                />
              </label>
              <label>
                Purpose
                <textarea
                  value={draft.purpose}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      purpose: event.target.value,
                    }))
                  }
                  rows={3}
                  maxLength={2000}
                />
              </label>
            </>
          ) : null}
          {draft.step === 2 ? (
            <label>
              Collection mode
              <select
                value={draft.mode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    mode: event.target.value as ResearchPortfolioMode,
                  }))
                }
              >
                <option value="manual">Manual</option>
                <option value="rules">Rules</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </label>
          ) : null}
          {draft.step === 3 ? (
            <section aria-label="Portfolio preview">
              <h2>{draft.name.trim()}</h2>
              <p>{draft.purpose.trim() || 'No purpose recorded.'}</p>
              <p>{draft.mode}</p>
              <p>
                The portfolio starts empty. Configure governed members and rules after creation.
              </p>
            </section>
          ) : null}
          {draft.attempt ? (
            <p role="status">
              The create outcome is pending or uncertain. Retry the original request before editing
              this draft.
            </p>
          ) : null}
          {storageError ? (
            <p className="rp-error" role="alert">
              The draft could not be retained in this browser. Enable session storage before
              creating.
            </p>
          ) : null}
          {create.error ? (
            <p className="rp-error" role="alert">
              {draft.attempt
                ? 'The response was not confirmed. Retry this request to recover its outcome.'
                : 'The request was rejected. Review the draft and try again.'}
            </p>
          ) : null}
          {draft.step > 1 && !draft.attempt ? (
            <button
              type="button"
              className="rp-button"
              disabled={create.isPending}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  step: current.step === 3 ? 2 : 1,
                }))
              }
            >
              Back
            </button>
          ) : null}
          <button
            className="rp-button rp-button--primary"
            disabled={create.isPending || !draft.name.trim() || storageError}
          >
            {create.isPending
              ? 'Creating…'
              : draft.attempt
                ? 'Retry create request'
                : draft.step === 3
                  ? 'Create portfolio'
                  : 'Continue'}
          </button>
        </form>
      ) : null}
      {query.isLoading ? <p className="rp-state">Loading research portfolios…</p> : null}
      {query.error ? (
        <div>
          <p className="rp-error" role="alert">
            Research portfolios could not be loaded.
          </p>
          <button
            className="rp-button"
            onClick={() => (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}
          >
            Retry loading portfolios
          </button>
        </div>
      ) : null}
      {query.isSuccess && items.length === 0 ? (
        <section className="rp-card rp-empty">
          <h2>No research portfolios yet</h2>
          <p>
            Create a manual collection, then add programs, program elements, projects, budget lines,
            or awards.
          </p>
        </section>
      ) : null}
      <section className="rp-grid" aria-label="Research portfolio results">
        {items.map((portfolio) => (
          <Link
            className="rp-card rp-portfolio-card"
            to={`/research-portfolios/${portfolio.id}`}
            key={portfolio.id}
          >
            <div className="rp-row rp-row--spread">
              <h2>{portfolio.name}</h2>
              <span className={`rp-badge rp-badge--${portfolio.lifecycle}`}>
                {portfolio.lifecycle}
              </span>
            </div>
            <p>{portfolio.purpose || 'No purpose recorded.'}</p>
            <dl className="rp-metrics">
              <div>
                <dt>Members</dt>
                <dd>{portfolio.memberCount}</dd>
              </div>
              <div>
                <dt>Clients</dt>
                <dd>{portfolio.clientLinkCount}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{portfolio.myRole}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{portfolio.mode}</dd>
              </div>
            </dl>
          </Link>
        ))}
      </section>
      {query.hasNextPage ? (
        <button
          type="button"
          className="rp-button"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading more…' : 'Load more portfolios'}
        </button>
      ) : null}
      <p role="status">
        {items.length} portfolios loaded
        {query.hasNextPage ? ' · more available' : ''}
      </p>
    </main>
  );
}
