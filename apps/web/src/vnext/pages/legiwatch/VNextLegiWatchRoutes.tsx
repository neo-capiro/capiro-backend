/**
 * LegiWatch vNext — module router (§11.1). Claims `/legiwatch` (the module's
 * landing tab is Hearings) and the live hearing room
 * `/intelligence/hearing-watch/:sessionId` (§7.8 — a route, not a tab; module
 * chrome suppressed; back returns to Hearings).
 *
 * `/bills/:billId` stays canonical — Bill 360's full-page mount is the same
 * component tree opened from the board (§4.1 #3); the vNext dossier drawer
 * links out to it rather than forking the dossier.
 */
import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { LegiWatchModule } from './LegiWatchModule.js';
import { LwStateLoading } from './states/SystemStates.js';

const LiveHearingRoomVNext = lazy(async () => ({
  default: (await import('./live/LiveHearingRoomVNext.js')).LiveHearingRoomVNext,
}));

// PR B (LW-QA-003/004/013): canonical hearing detail + committee room routes.
const HearingDetailRoute = lazy(async () => ({
  default: (await import('./hearings/HearingDetailRoute.js')).HearingDetailRoute,
}));
const CommitteeRoomRoute = lazy(async () => ({
  default: (await import('./hearings/CommitteeRoomRoute.js')).CommitteeRoomRoute,
}));

function LiveRoomRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  if (!sessionId) return <Navigate to="/legiwatch?tab=hearings" replace />;
  return (
    <Suspense
      fallback={
        <div className="lw" style={{ padding: 24 }}>
          <LwStateLoading rows={4} />
        </div>
      }
    >
      <LiveHearingRoomVNext sessionId={sessionId} />
    </Suspense>
  );
}

function HearingDetailRouteWrapped() {
  const { hearingId } = useParams<{ hearingId: string }>();
  if (!hearingId) return <Navigate to="/legiwatch?tab=hearings" replace />;
  return (
    <Suspense
      fallback={
        <div className="lw" style={{ padding: 24 }}>
          <LwStateLoading rows={4} />
        </div>
      }
    >
      <div className="lw"><HearingDetailRoute /></div>
    </Suspense>
  );
}

function CommitteeRoomRouteWrapped() {
  const { systemCode } = useParams<{ systemCode: string }>();
  if (!systemCode) return <Navigate to="/legiwatch?tab=hearings" replace />;
  return (
    <Suspense
      fallback={
        <div className="lw" style={{ padding: 24 }}>
          <LwStateLoading rows={4} />
        </div>
      }
    >
      <div className="lw"><CommitteeRoomRoute /></div>
    </Suspense>
  );
}

function LegacyRadarRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={`/legiwatch${search}${hash}`} replace />;
}

export function VNextLegiWatchRoutes() {
  return (
    <Routes>
      <Route path="/radar" element={<LegacyRadarRedirect />} />
      <Route path="/legiwatch" element={<LegiWatchModule />} />
      {/* PR B — canonical hearing detail (LW-QA-003/004). */}
      <Route path="/legiwatch/hearings/:hearingId" element={<HearingDetailRouteWrapped />} />
      {/* PR B — committee room (LW-QA-013). */}
      <Route path="/legiwatch/committees/:systemCode" element={<CommitteeRoomRouteWrapped />} />
      {/* §7.8 — the live hearing room is a full-width route. */}
      <Route path="/intelligence/hearing-watch/:sessionId" element={<LiveRoomRoute />} />
      {/* §7.2/§7.9 — removed surfaces canonicalize onto the landing tab. */}
      <Route path="/legiwatch/*" element={<Navigate to="/legiwatch?tab=hearings" replace />} />
    </Routes>
  );
}

/** Path predicate for VNextRouter: the module owns `/legiwatch` and the live
 *  hearing room route. Everything else falls through to canonical. */
export function isVNextLegiWatchPath(pathname: string): boolean {
  if (pathname === '/radar') return true;
  if (pathname === '/legiwatch' || pathname.startsWith('/legiwatch/')) return true;
  // The live room only when it carries a session id — the bare
  // `/intelligence/hearing-watch` index already redirects to `?tab=hearings`.
  return /^\/intelligence\/hearing-watch\/.+/.test(pathname);
}
