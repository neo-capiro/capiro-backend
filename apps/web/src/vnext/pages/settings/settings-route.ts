/**
 * Settings vNext — path predicate for VNextRouter, in its own UI-free module
 * (same pattern as directory-routes.ts / district-nexus-route.ts) so the
 * router and its tests can consult the claim without pulling the whole
 * Settings page tree into the eager bundle.
 *
 * The module owns the WHOLE /settings prefix: the layout with role-filtered
 * tabs plus every sub-page registered under /settings in App.tsx. The legacy
 * /admin, /admin/* and /capiro-admin redirects stay canonical <Navigate>s —
 * they land on /settings/... and are then claimed here.
 */
export function isVNextSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}
