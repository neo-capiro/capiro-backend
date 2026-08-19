/**
 * Program Elements vNext profile — explicit load / failure states.
 * Native port of the PeLoadState states the line profile actually reaches
 * (loading / failed / not_found / unsupported), on Capiro feedback primitives.
 * Failed payloads must never render as a valid empty profile; copy and
 * data-testids match the canonical component so ported tests keep meaning.
 */
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';

export function PeProfileLoading() {
  return (
    <div data-testid="pe-state-loading" style={{ padding: 24, display: 'grid', gap: 12 }}>
      <CapiroSkeleton height={30} width="42%" />
      <CapiroSkeleton height={16} width="66%" />
      <div style={{ display: 'flex', gap: 12 }}>
        {[0, 1, 2, 3].map((idx) => (
          <CapiroSkeleton key={idx} height={52} />
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5].map((idx) => (
        <CapiroSkeleton key={idx} height={16} />
      ))}
    </div>
  );
}

export function PeProfileFailedState({
  state,
  peCode,
  onRetry,
}: {
  state: 'failed' | 'not_found';
  peCode?: string;
  onRetry?: () => void;
}) {
  const is404 = state === 'not_found';
  return (
    <div data-testid={is404 ? 'pe-state-not-found' : 'pe-state-failed'} style={{ padding: 24 }}>
      <CapiroErrorState
        title={is404 ? 'Program element not found' : 'Unable to load program element'}
        description={
          is404
            ? peCode
              ? `No PE record exists for ${peCode}. This is not an empty watch page.`
              : 'Missing PE code.'
            : 'The detail request failed. Do not treat this as an empty or ungagged PE — retry before acting on missing data.'
        }
        onRetry={onRetry}
        retryLabel="Retry"
      />
    </div>
  );
}

export function PeProfileUnsupportedState() {
  return (
    <div data-testid="pe-state-unsupported" style={{ padding: 24 }}>
      <CapiroErrorState
        title="Unsupported source family"
        description="This line belongs to a source family Capiro does not yet support for canonical PE dollars. No fabricated budget figures are shown."
      />
    </div>
  );
}

export function PeProfileMissingCode() {
  return (
    <div style={{ padding: 24 }}>
      <CapiroErrorState title="Missing Program Element code" />
    </div>
  );
}
