import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApplyResearchPortfolioWatchConversionDto,
  ResearchPortfolioWatchConversionPreviewDto,
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
function hasCurrentPreview(
  value: unknown,
  portfolioId: string,
): value is ResearchPortfolioWatchConversionPreviewDto {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Partial<ResearchPortfolioWatchConversionPreviewDto>;
  return (
    preview.portfolioId === portfolioId &&
    Number.isSafeInteger(preview.expectedRevision) &&
    (preview.expectedRevision ?? 0) > 0 &&
    typeof preview.previewHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(preview.previewHash) &&
    Number.isSafeInteger(preview.legacyWatches) &&
    (preview.legacyWatches ?? -1) >= 0 &&
    Number.isSafeInteger(preview.convertibleWatches) &&
    (preview.convertibleWatches ?? -1) >= 0 &&
    Number.isSafeInteger(preview.alreadyConverted) &&
    (preview.alreadyConverted ?? -1) >= 0 &&
    Array.isArray(preview.limitations) &&
    preview.limitations.every((reason) => typeof reason === 'string') &&
    Array.isArray(preview.previewItems) &&
    preview.previewItems.every(
      (item) =>
        item &&
        typeof item.watchId === 'string' &&
        typeof item.userId === 'string' &&
        typeof item.channel === 'string' &&
        typeof item.legacyKind === 'string' &&
        item.targetKind === 'program_element' &&
        typeof item.targetId === 'string' &&
        item.active === false &&
        ['convertible', 'already_subscribed', 'not_included_member'].includes(item.reason) &&
        typeof item.willConvert === 'boolean',
    )
  );
}
function confirmsExactConversion(
  value: ResearchPortfolioWatchConversionResultDto,
  portfolioId: string,
  idempotencyKey: string,
): boolean {
  return (
    value?.portfolioId === portfolioId &&
    value.idempotencyKey === idempotencyKey &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    Number.isSafeInteger(value.convertedCount) &&
    value.convertedCount >= 0 &&
    Number.isSafeInteger(value.skippedCount) &&
    value.skippedCount >= 0 &&
    Array.isArray(value.limitations) &&
    value.limitations.every((reason) => typeof reason === 'string')
  );
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
    queryKey: [
      'research-portfolios',
      portfolioId,
      'watch-conversion',
      scope,
      attempt?.idempotencyKey ?? null,
    ],
    queryFn: () => previewResearchPortfolioWatchConversion(api, portfolioId),
    enabled: false,
    retry: false,
  });
  const currentPreview = hasCurrentPreview(preview.data, portfolioId) ? preview.data : null;
  const apply = useMutation({
    mutationFn: async () => {
      if (initial.error) throw Error(initial.error);
      if (!canEdit) throw Error('Portfolio edit access required');
      const request =
        attempt ??
        (currentPreview && confirmed && selected.length
          ? {
              idempotencyKey: newIdempotencyKey('watch-conversion'),
              expectedRevision: currentPreview.expectedRevision,
              previewHash: currentPreview.previewHash,
              selectedWatchIds: [...selected].sort(),
            }
          : null);
      if (!currentPreview)
        throw Error('A complete current API preview is required before any conversion request');
      if (!request) throw Error('Preview, select and confirm dormant watch creation first');
      // A cached preview can survive a failed refetch while the API rolls back.
      // Check the server again before either a new write or an exact retry.
      const freshPreview = await previewResearchPortfolioWatchConversion(api, portfolioId);
      if (!hasCurrentPreview(freshPreview, portfolioId))
        throw Error('The current API cannot confirm a complete watch conversion preview');
      if (
        !attempt &&
        (freshPreview.expectedRevision !== request.expectedRevision ||
          freshPreview.previewHash !== request.previewHash)
      )
        throw Error('Watch conversion preview changed; review a fresh preview before applying');
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
      const result = await applyResearchPortfolioWatchConversion(api, portfolioId, request);
      if (!confirmsExactConversion(result, portfolioId, request.idempotencyKey))
        throw Error('The API response did not confirm this exact conversion');
      return result;
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
        disabled={preview.isFetching}
        onClick={() => void preview.refetch()}
      >
        Preview my legacy watches
      </button>
      {preview.error ? (
        <p role="alert">The current watch conversion preview is unavailable. Retry the preview.</p>
      ) : null}
      {preview.data && !currentPreview ? (
        <p role="alert">
          Watch conversion is unavailable until the API provides a complete preview. No conversion
          request was sent; any retained exact request is preserved.
        </p>
      ) : null}
      {currentPreview ? (
        <>
          <p>
            {currentPreview.convertibleWatches} convertible · {currentPreview.alreadyConverted} already
            subscribed · revision {currentPreview.expectedRevision}
          </p>
          {currentPreview.limitations.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          <ul className="rp-list">
            {currentPreview.previewItems.map((item) => (
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
          exact request after checking the current API preview.
        </p>
      ) : (
        <label className="rp-checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!canEdit || !currentPreview}
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
          !currentPreview ||
          (!attempt && (!selected.length || !confirmed))
        }
        onClick={() => apply.mutate()}
      >
        {attempt ? 'Reconcile exact watch conversion' : 'Create selected dormant watches'}
      </button>
      {!canEdit ? <p>Current portfolio edit access is required to convert watches.</p> : null}
      {storageError ? <p role="alert">{storageError}</p> : null}
      {apply.error ? (
        <p role="alert">
          {attempt
            ? 'Watch conversion is unconfirmed. Retry the retained exact request; a replacement selection is not sent.'
            : 'Watch conversion was not sent. Review a fresh preview and retry.'}
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
