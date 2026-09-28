import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyResearchPortfolioWatchConversionDto,
  ResearchPortfolioWatchConversionResultDto,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  ResearchPortfolioAuthorityBoundary,
  useResearchPortfolioAuthorityScope,
} from './research-portfolio-authority.js';
import {
  applyResearchPortfolioWatchConversion,
  previewResearchPortfolioWatchConversion,
  newIdempotencyKey,
  researchPortfolioKeys,
} from './research-portfolios-api.js';
interface Props {
  portfolioId: string;
  canEdit: boolean;
}
export function ResearchPortfolioWatchConversionPanel(props: Props) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <WatchConversionContent key={props.portfolioId} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}
function WatchConversionContent({ portfolioId, canEdit }: Props) {
  const api = useApi(),
    queryClient = useQueryClient(),
    scope = useResearchPortfolioAuthorityScope()!;
  const storageKey = `capiro:research-portfolio-watch-conversion:v1:${JSON.stringify([scope, portfolioId])}`;
  const [initial] = useState(() => {
    try {
      const text = localStorage.getItem(storageKey);
      if (!text) return { attempt: null, error: null };
      const value = JSON.parse(text) as ApplyResearchPortfolioWatchConversionDto;
      if (
        typeof value.idempotencyKey !== 'string' ||
        !value.idempotencyKey ||
        value.idempotencyKey.length > 128 ||
        !Number.isInteger(value.expectedRevision) ||
        value.expectedRevision < 0 ||
        typeof value.previewHash !== 'string' ||
        !value.previewHash ||
        !Array.isArray(value.selectedWatchIds) ||
        !value.selectedWatchIds.length ||
        value.selectedWatchIds.length > 1000 ||
        value.selectedWatchIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(value.selectedWatchIds).size !== value.selectedWatchIds.length
      )
        throw Error('The retained watch conversion is invalid. Do not send a replacement request.');
      return { attempt: value, error: null };
    } catch (error) {
      return { attempt: null, error: (error as Error).message };
    }
  });
  const [attempt, setAttempt] = useState<ApplyResearchPortfolioWatchConversionDto | null>(
    initial.attempt,
  );
  const [selected, setSelected] = useState<string[]>([
    ...(initial.attempt?.selectedWatchIds ?? []),
  ]);
  const [confirmed, setConfirmed] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const [receipt, setReceipt] = useState<ResearchPortfolioWatchConversionResultDto | null>(null);
  const preview = useQuery({
    queryKey: ['research-portfolios', portfolioId, 'watch-conversion', scope],
    queryFn: () => previewResearchPortfolioWatchConversion(api, portfolioId),
    enabled: false,
    retry: false,
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (initial.error) throw Error(initial.error);
      if (!canEdit) throw Error('Portfolio edit access required');
      const request =
        attempt ??
        (preview.data && confirmed && selected.length
          ? {
              idempotencyKey: newIdempotencyKey('watch-conversion'),
              expectedRevision: preview.data.expectedRevision,
              previewHash: preview.data.previewHash,
              selectedWatchIds: [...selected].sort(),
            }
          : null);
      if (!request) throw Error('Preview, select and confirm dormant watch creation first');
      try {
        localStorage.setItem(storageKey, JSON.stringify(request));
      } catch {
        setStorageError(
          'The exact watch conversion could not be retained. No conversion was sent. Free browser storage and retry.',
        );
        throw Error('Watch storage unavailable');
      }
      setAttempt(request);
      setStorageError(null);
      return applyResearchPortfolioWatchConversion(api, portfolioId, request);
    },
    onSuccess: (result) => {
      setReceipt(result);
      setAttempt(null);
      setSelected([]);
      setConfirmed(false);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        setStorageError(
          'The server confirmed this conversion, but its completed request could not be cleared. Retry that exact identity if it reappears.',
        );
      }
      void queryClient.invalidateQueries({
        queryKey: researchPortfolioKeys.subscriptions(portfolioId),
      });
    },
  });
  return (
    <section className="rp-watch-conversion" aria-label="Convert my legacy watches">
      <h3>Convert my legacy watches</h3>
      <p>
        Choose legacy watches to create dormant in-app subscriptions. Existing subscription
        preferences and legacy watches are preserved. No notification is sent; activation requires a
        separate Resume action.
      </p>
      <button
        className="rp-button"
        disabled={preview.isFetching || Boolean(attempt)}
        onClick={() => void preview.refetch()}
      >
        Preview my legacy watches
      </button>
      {preview.error ? (
        <p role="alert">The current watch conversion preview is unavailable. Retry the preview.</p>
      ) : null}
      {preview.data ? (
        <>
          <p>
            {preview.data.convertibleWatches} convertible · {preview.data.alreadyConverted} already
            subscribed · revision {preview.data.expectedRevision}
          </p>
          {preview.data.limitations.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          <ul className="rp-list">
            {preview.data.previewItems.map((item) => (
              <li key={item.watchId}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Convert legacy watch for PE ${item.targetId}`}
                    disabled={!canEdit || Boolean(attempt) || item.reason !== 'convertible'}
                    checked={selected.includes(item.watchId)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, item.watchId]
                          : previous.filter((id) => id !== item.watchId),
                      )
                    }
                  />
                  {item.targetKind.replaceAll('_', ' ')} {item.targetId} ·{' '}
                  {item.reason.replaceAll('_', ' ')}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {attempt ? (
        <p className="rp-notice">
          The prior conversion may have committed. The original selection of{' '}
          {attempt.selectedWatchIds.length} watches, preview and key are retained. Reconcile that
          exact request.
        </p>
      ) : (
        <label className="rp-checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!canEdit}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm creating dormant watches without sending notifications.
        </label>
      )}
      <button
        className="rp-button"
        disabled={
          !canEdit ||
          Boolean(initial.error) ||
          apply.isPending ||
          (!attempt && (!preview.data || !selected.length || !confirmed))
        }
        onClick={() => apply.mutate()}
      >
        {attempt ? 'Reconcile exact watch conversion' : 'Create selected dormant watches'}
      </button>
      {!canEdit ? <p>Current portfolio edit access is required to convert watches.</p> : null}
      {storageError ? <p role="alert">{storageError}</p> : null}
      {apply.error ? (
        <p role="alert">
          Watch conversion is unconfirmed. Retry the retained exact request; a replacement selection
          is not sent.
        </p>
      ) : null}
      {receipt ? (
        <div role="status">
          <p>
            Created {receipt.convertedCount} dormant watches; skipped {receipt.skippedCount}. No
            notifications were sent.
          </p>
          {receipt.limitations.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
