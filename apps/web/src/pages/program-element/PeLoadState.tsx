import { Alert, Button, Empty, Skeleton } from 'antd';
import type { ReactNode } from 'react';
import type { PeSurfaceState } from './trust-model.js';
import { peSurfaceFailedAsEmpty } from './trust-model.js';

export interface PeLoadStateProps {
  state: PeSurfaceState;
  peCode?: string;
  onRetry?: () => void;
  /** Optional body when state is complete_* / partial — parent renders children. */
  children?: ReactNode;
}

/**
 * Explicit PE surface states. Failed payloads must never render as a valid empty catalog.
 */
export function PeLoadState({ state, peCode, onRetry, children }: PeLoadStateProps) {
  if (state === 'loading') {
    return (
      <section className="pe-watch-page redesign" data-testid="pe-state-loading">
        <Skeleton active paragraph={{ rows: 3 }} />
        <div className="pe-strip">
          {[0, 1, 2, 3].map((idx) => (
            <div className="pe-strip-cell" key={idx}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (peSurfaceFailedAsEmpty(state)) {
    const is404 = state === 'not_found';
    return (
      <div data-testid={is404 ? 'pe-state-not-found' : 'pe-state-failed'}>
        <Alert
          type="error"
          showIcon
          message={is404 ? 'Program element not found' : 'Unable to load program element'}
          description={
            is404
              ? peCode
                ? `No PE record exists for ${peCode}. This is not an empty watch page.`
                : 'Missing PE code.'
              : 'The detail request failed. Do not treat this as an empty or ungagged PE — retry before acting on missing data.'
          }
          action={
            onRetry ? (
              <Button size="small" danger onClick={onRetry} data-testid="pe-state-retry">
                Retry
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div data-testid="pe-state-unsupported">
        <Alert
          type="warning"
          showIcon
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
        <Empty
          style={{ marginTop: 24 }}
          description={
            state === 'not_ingested'
              ? 'PE identity is known, but no budget-year rows have been ingested yet.'
              : 'Ingested structure is present but no dollar stages are populated for this PE.'
          }
        />
      </div>
    );
  }

  if (state === 'partial') {
    return (
      <div data-testid="pe-state-partial">
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Partial data"
          description="The PE detail loaded, but one or more secondary panels failed. Loaded sections below remain usable; failed sections are marked — not silently empty."
          action={
            onRetry ? (
              <Button size="small" onClick={onRetry} data-testid="pe-state-retry">
                Retry failed panels
              </Button>
            ) : undefined
          }
        />
        {children}
      </div>
    );
  }

  // complete_with_data
  return <div data-testid="pe-state-complete">{children}</div>;
}

export default PeLoadState;
