import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { consumePreviewActivation } from '../../lib/engagement-api-preview.js';
import { EngagementApiPreviewIndicator } from './EngagementApiPreviewIndicator.js';

/**
 * Consumes the `?engagement-api-preview=` activation parameter (Phase 3, 3.3).
 *
 * It is mounted once beside the route table rather than inside the Engagement
 * route because the mode is session-wide, not page-wide: 3.8 requires the
 * preview to apply while the SPA route is `/settings/integrations`, and an
 * operator may activate from any deep link. Mounting it here also avoids a
 * second EngagementPage registration — the existing `/engagement/*` route is
 * untouched.
 *
 * The parameter is consumed and removed; every other query parameter survives
 * unchanged, so activating on a meeting deep link keeps the meeting ID, detail
 * tab, date range and client filter. The rewrite is a `replace`, so activation
 * does not add a back-button step.
 */
export function EngagementPreviewBoundary() {
  const location = useLocation();
  const navigate = useNavigate();
  // Guards against re-consuming during the render pass that follows our own
  // navigate(): the effect re-runs on the new search, which no longer has the
  // parameter, so this is belt-and-braces against a double-apply loop.
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    const search = location.search;
    if (lastHandled.current === search) return;
    lastHandled.current = search;

    const result = consumePreviewActivation(search);
    if (!result.changed) return;

    navigate(
      { pathname: location.pathname, search: result.nextSearch, hash: location.hash },
      { replace: true },
    );
  }, [location.search, location.pathname, location.hash, navigate]);

  return <EngagementApiPreviewIndicator />;
}
