import { useLocation } from 'react-router-dom';
import {
  clearEngagementPreview,
  isEngagementPreviewActive,
} from '../../lib/engagement-api-preview.js';
import './engagement-preview.css';

const PREVIEW_LABEL = 'Engagement API preview — External actions are disabled';

export function turnOffEngagementPreview(reload: () => void = () => window.location.reload()): void {
  clearEngagementPreview();
  // 3.9 replaces this hard reload with Engagement-only query invalidation once
  // the complete cache-family inventory is proven. A reload is intentionally
  // used in 3.4 so no stale preview response can be presented as canonical
  // after mode-off. Reload preserves the exact current URL.
  reload();
}

/**
 * Small internal-only operator affordance for Phase 3 parity testing. The copy
 * is deliberately fixed: never interpolate tenant/client/target/auth/runtime
 * identifiers into this surface.
 */
export function EngagementApiPreviewIndicator() {
  // The activation boundary removes its query parameter with a router replace.
  // Reading location here makes that navigation re-render this component after
  // sessionStorage has been updated, without adding another global store.
  useLocation();

  if (!isEngagementPreviewActive()) return null;

  return (
    <aside className="engagement-preview-indicator" aria-label="Engagement API preview status">
      <span className="engagement-preview-indicator__text" role="status">
        {PREVIEW_LABEL}
      </span>
      <button
        type="button"
        className="engagement-preview-indicator__button"
        onClick={() => turnOffEngagementPreview()}
      >
        Turn off preview
      </button>
    </aside>
  );
}

export const ENGAGEMENT_PREVIEW_INDICATOR_LABEL = PREVIEW_LABEL;
