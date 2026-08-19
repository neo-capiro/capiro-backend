/**
 * Explicit PE surface states — native vNext port of
 * `pages/program-element/PeLoadState.tsx`. Failed payloads must never render
 * as a valid empty catalog. Identical testids + copy.
 */
import type { ReactNode } from 'react';
import type { PeSurfaceState } from '../../../../pages/program-element/trust-model.js';
import { peSurfaceFailedAsEmpty } from '../../../../pages/program-element/trust-model.js';
import { PeFbEmpty, PeFbErrorState, PeFbNotice, PeFbRetryButton, PeFbSkeleton } from './pe-fallback-ui.js';

export interface PeLoadStateVNextProps {
  state: PeSurfaceState;
  peCode?: string;
  onRetry?: () => void;
  /** Optional body when state is complete_* / partial — parent renders children. */
  children?: ReactNode;
}

export function PeLoadStateVNext({ state, peCode, onRetry, children }: PeLoadStateVNextProps) {
  if (state === 'loading') {
    return (
      <section className="pe-fb-root" data-testid="pe-state-loading">
        <PeFbSkeleton rows={3} />
        <div className="pe-fb-kpis" style={{ marginTop: 14 }}>
          {[0, 1, 2, 3].map((idx) => (
            <div className="pe-fb-kpi" key={idx}>
              <PeFbSkeleton rows={1} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (peSurfaceFailedAsEmpty(state)) {
    const is404 = state === 'not_found';
    return (
      <PeFbErrorState
        testId={is404 ? 'pe-state-not-found' : 'pe-state-failed'}
        message={is404 ? 'Program element not found' : 'Unable to load program element'}
        description={
          is404
            ? peCode
              ? `No PE record exists for ${peCode}. This is not an empty watch page.`
              : 'Missing PE code.'
            : 'The detail request failed. Do not treat this as an empty or ungagged PE — retry before acting on missing data.'
        }
        onRetry={onRetry}
        retryTestId="pe-state-retry"
      />
    );
  }

  if (state === 'unsupported') {
    return (
      <div data-testid="pe-state-unsupported">
        <PeFbNotice
          tone="warning"
          message="Unsupported source family"
          description="This line belongs to a source family Capiro does not yet support for canonical PE dollars. No fabricated budget figures are shown."
        />
      </div>
    );
  }

  if (state === 'not_ingested' || state === 'complete_empty') {
    return (
      <div data-testid={state === 'not_ingested' ? 'pe-state-not-ingested' : 'pe-state-complete-empty'}>
        {children}
        <div style={{ marginTop: 24 }}>
          <PeFbEmpty
            description={
              state === 'not_ingested'
                ? 'PE identity is known, but no budget-year rows have been ingested yet.'
                : 'Ingested structure is present but no dollar stages are populated for this PE.'
            }
          />
        </div>
      </div>
    );
  }

  if (state === 'partial') {
    return (
      <div data-testid="pe-state-partial">
        <PeFbNotice
          tone="warning"
          message="Partial data"
          description="The PE detail loaded, but one or more secondary panels failed. Loaded sections below remain usable; failed sections are marked — not silently empty."
          style={{ marginBottom: 12 }}
          action={onRetry ? <PeFbRetryButton onClick={onRetry} testId="pe-state-retry" /> : undefined}
        />
        {children}
      </div>
    );
  }

  // complete_with_data
  return <div data-testid="pe-state-complete">{children}</div>;
}
