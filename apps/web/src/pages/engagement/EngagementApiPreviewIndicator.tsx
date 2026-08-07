import { useLocation, useNavigate } from 'react-router-dom';
import {
  ENGAGEMENT_PREVIEW_QUERY_PARAM,
  isEngagementPreviewActive,
} from '../../lib/engagement-api-preview.js';
import './engagement-preview.css';

const PREVIEW_LABEL = 'Engagement API preview — External actions are disabled';

/** Build the same URL with only the internal mode-control parameter set. */
export function previewTurnOffSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.set(ENGAGEMENT_PREVIEW_QUERY_PARAM, 'off');
  const next = params.toString();
  return next ? `?${next}` : `?${ENGAGEMENT_PREVIEW_QUERY_PARAM}=off`;
}

/**
 * Small internal-only operator affordance for Phase 3 parity testing. The copy
 * is deliberately fixed: never interpolate tenant/client/target/auth/runtime
 * identifiers into this surface.
 */
export function EngagementApiPreviewIndicator() {
  const location = useLocation();
  const navigate = useNavigate();

  if (!isEngagementPreviewActive()) return null;

  return (
    <aside className="engagement-preview-indicator" aria-label="Engagement API preview status">
      <span className="engagement-preview-indicator__text" role="status">
        {PREVIEW_LABEL}
      </span>
      <button
        type="button"
        className="engagement-preview-indicator__button"
        onClick={() => {
          // Route mode-off through EngagementPreviewBoundary so the same
          // targeted cache cancellation/removal runs in both directions. The
          // boundary consumes this parameter with a history replace, preserving
          // pathname, hash, and every unrelated query parameter.
          navigate(
            {
              pathname: location.pathname,
              search: previewTurnOffSearch(location.search),
              hash: location.hash,
            },
            { replace: true },
          );
        }}
      >
        Turn off preview
      </button>
    </aside>
  );
}

export const ENGAGEMENT_PREVIEW_INDICATOR_LABEL = PREVIEW_LABEL;
