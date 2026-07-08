import type React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { useFunnelSession, type FunnelState } from '../../lib/funnel';

export const FUNNEL_ROUTES = [
  '/register',
  '/verify',
  '/plan',
  '/legal',
  '/billing',
  '/admins',
  '/clients',
  '/org',
  '/confirm',
] as const;

export type FunnelRoute = (typeof FUNNEL_ROUTES)[number];

/** session.state → the single (furthest) route the user may be on. */
export function routeForState(state: FunnelState | undefined): FunnelRoute {
  switch (state) {
    case 'registered':
      return '/verify';
    case 'verified':
      return '/plan';
    case 'plan_selected':
      return '/legal';
    case 'legal_accepted':
      return '/billing';
    case 'payment_on_file':
      return '/admins';
    case 'roles_designated':
      return '/clients';
    case 'import_pref':
      return '/org';
    case 'org_setup':
    case 'provisioning':
    case 'provisioned':
    case 'failed':
      return '/confirm';
    default:
      return '/register';
  }
}

/**
 * Redirects deep links forward/back to the furthest route the funnel session
 * allows. Unauthenticated visitors can only see /register (and /verify while
 * a Clerk sign-up is in flight — the page itself bounces if none exists).
 */
export function FunnelStepGuard({
  route,
  children,
}: {
  route: FunnelRoute;
  children: React.ReactElement;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const session = useFunnelSession();

  if (!isLoaded) return null;
  if (!isSignedIn) {
    return route === '/register' || route === '/verify' ? (
      children
    ) : (
      <Navigate to="/register" replace />
    );
  }
  if (session.isLoading) return null;
  if (!session.data) {
    // Signed in but no funnel session yet (register POST pending / not made).
    return route === '/register' || route === '/verify' ? (
      children
    ) : (
      <Navigate to="/register" replace />
    );
  }
  const allowed = routeForState(session.data.state);
  // Once provisioning has started (org_setup → …), pin the user to the
  // confirmation screen — earlier steps can no longer be edited.
  if (allowed === '/confirm') {
    return route === '/confirm' ? children : <Navigate to="/confirm" replace />;
  }
  // Otherwise let the user step BACK to any completed data-entry page (down to
  // /plan) while still bouncing forward jumps to the furthest allowed step.
  const allowedIdx = FUNNEL_ROUTES.indexOf(allowed);
  const routeIdx = FUNNEL_ROUTES.indexOf(route);
  const backFloorIdx = FUNNEL_ROUTES.indexOf('/plan');
  const minIdx = Math.min(allowedIdx, backFloorIdx);
  if (routeIdx < minIdx || routeIdx > allowedIdx) {
    return <Navigate to={allowed} replace />;
  }
  return children;
}
