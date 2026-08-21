import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { listReviewQueue } from './defense-budget-lifecycle-api.js';
import './defense-budget-lifecycle-vnext.css';

const DEFAULT_FISCAL_YEAR = 2027;

/**
 * Phase 8 Session 11 — review queue (read-only).
 *
 * This page shows every `review_required` hold with the full context a
 * human needs to judge it — it does not, and cannot, resolve one. The
 * Session 7 migration grants `capiro_defense_serve` (the role the HTTP
 * process uses) SELECT-only on this table; only the governed
 * `run-review-resolution.mjs` job-role command can move an item out of
 * review. Showing a working "Resolve" button here would be a UI making a
 * promise the backend cannot keep, so the affordance is explicitly
 * explained rather than faked.
 */
export function DefenseBudgetLifecycleReviewQueuePage() {
  const api = useApi();
  const me = useMe();
  const isInternal = me.data?.tenant.slug === 'capiro-internal';
  const [searchParams] = useSearchParams();
  const fiscalYear = Number(searchParams.get('fiscalYear') ?? DEFAULT_FISCAL_YEAR);

  const queueQuery = useQuery({
    queryKey: ['defense-budget-lifecycle-review-queue', fiscalYear],
    queryFn: () => listReviewQueue(api, fiscalYear),
    enabled: isInternal && Number.isFinite(fiscalYear),
    staleTime: 30_000,
  });

  if (!isInternal) {
    return (
      <section className="dbl-vnext" data-screen-label="Defense budget lifecycle review queue">
        <CapiroEmptyState
          title="Not available for this workspace"
          description="The review queue is a Capiro-internal analyst view."
        />
      </section>
    );
  }

  return (
    <section className="dbl-vnext" data-screen-label="Defense budget lifecycle review queue">
      <div className="dbl-vnext-head">
        <div>
          <div className="dbl-vnext-title">Review queue — FY{fiscalYear}</div>
          <div className="dbl-vnext-sub">
            Sources the discovery classifier could not confidently place. Resolution runs through
            the governed <code>run-review-resolution.mjs</code> operator command, not this page —
            see the operator runbook.
          </div>
        </div>
        <Link to="/defense-budget-lifecycle" className="dbl-vnext-link">
          ← Cycle health
        </Link>
      </div>

      <div className="dbl-vnext-card">
        {queueQuery.isLoading ? (
          <div style={{ padding: 24 }}>
            <CapiroSkeleton height={120} />
          </div>
        ) : queueQuery.isError ? (
          <div style={{ padding: 24 }}>
            <CapiroErrorState description="Could not load the review queue." onRetry={() => queueQuery.refetch()} />
          </div>
        ) : !queueQuery.data || queueQuery.data.length === 0 ? (
          <div style={{ padding: '32px 24px' }}>
            <CapiroEmptyState
              title="Nothing held for review"
              description={`Every FY${fiscalYear} expected source is either published, not yet filed, or otherwise resolved.`}
            />
          </div>
        ) : (
          <ul className="dbl-vnext-review-list" aria-label="Review-required expected sources">
            {queueQuery.data.map((item) => (
              <li key={item.expectedSourceId} className="dbl-vnext-review-item">
                <div className="dbl-vnext-review-item-head">
                  <span className="dbl-vnext-mono">{item.authorityTrack}</span>
                  <span className="dbl-vnext-mono">{item.stage}</span>
                  <strong>{item.label}</strong>
                  <CapiroBadge tone="warning">review required</CapiroBadge>
                </div>
                <div className="dbl-vnext-review-item-body">
                  <div>
                    <strong>Why:</strong> {item.expectedSourceReviewReason ?? '(no reason recorded)'}
                  </div>
                  {item.observation.reviewReasons.length > 0 ? (
                    <ul className="dbl-vnext-review-reasons">
                      {item.observation.reviewReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="dbl-vnext-review-item-meta">
                    <span>
                      Discovered:{' '}
                      <a href={item.observation.discoveredUrl} target="_blank" rel="noreferrer">
                        {item.observation.discoveredUrl}
                      </a>
                    </span>
                    <span className="dbl-vnext-mono">sha256: {item.observation.contentSha256}</span>
                    {item.observation.classificationConfidence != null ? (
                      <span>confidence: {(item.observation.classificationConfidence * 100).toFixed(0)}%</span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="dbl-vnext-resolve-disabled"
                  disabled
                  title="Resolution runs through the governed run-review-resolution.mjs operator command — see the operator runbook."
                >
                  Resolve (operator command required)
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
