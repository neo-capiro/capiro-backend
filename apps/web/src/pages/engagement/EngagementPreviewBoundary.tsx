import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  consumePreviewActivation,
  readEngagementPreviewMode,
} from '../../lib/engagement-api-preview.js';
import { activateOutreachV3Preview, clearOutreachV3Preview } from './outreach/v3/outreach-v3-preview.js';
import { clearEngagementPreviewQueries } from '../../lib/engagement-preview-cache.js';
import { EngagementApiPreviewIndicator } from './EngagementApiPreviewIndicator.js';

/**
 * Consumes the `?engagement-api-preview=` activation parameter.
 *
 * It is mounted once beside the route table rather than inside the Engagement
 * route because the mode is session-wide: `/settings/integrations` and several
 * mixed pages are Engagement consumers too.
 *
 * A real mode transition cancels and removes only proven Engagement-owned
 * React Query entries before the URL is rewritten. This prevents a cached main
 * response from becoming preview evidence (or vice versa) while preserving
 * Directory, Workspace, Strategy, and other owner caches on mixed pages.
 */
export function EngagementPreviewBoundary() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    const search = location.search;
    if (lastHandled.current === search) return;
    lastHandled.current = search;

    const before = readEngagementPreviewMode();
    const result = consumePreviewActivation(search);
    if (!result.changed) return;

    // Couple the two preview switches: activating engagement-api-preview also
    // activates outreach-v3-preview, and deactivating also clears it. This
    // ensures users on the canonical app get V3 outreach when they opt into
    // the preview, without needing to manually activate two separate URL params.
    if (result.mode === 'v3') activateOutreachV3Preview();
    else if (result.mode === 'off') clearOutreachV3Preview();

    const finish = () =>
      navigate(
        { pathname: location.pathname, search: result.nextSearch, hash: location.hash },
        { replace: true },
      );

    if (result.mode !== before) {
      void clearEngagementPreviewQueries(queryClient).then(finish);
      return;
    }
    // Unknown activation values and idempotent `v3`/`off` requests still have
    // their control parameter consumed, but do not evict a cache for a mode
    // that never changed.
    finish();
  }, [location.search, location.pathname, location.hash, navigate, queryClient]);

  return <EngagementApiPreviewIndicator />;
}
