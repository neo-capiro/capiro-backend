/**
 * Path predicate for VNextRouter's District Nexus claim.
 *
 * Kept in its own UI-free module (pattern: engagement-route-state.ts) because
 * VNextRouter imports it EAGERLY — the page itself, and the MapLibre engine
 * behind it, must only ever load through the router's React.lazy boundary
 * (see bundle-boundaries.test.ts).
 *
 * The module owns exactly the canonical route (App.tsx registers the single
 * exact path `/intelligence/district-nexus`; district selection travels in
 * the `?district=` query param, never the path).
 */
export function isVNextDistrictNexusPath(pathname: string): boolean {
  return pathname === '/intelligence/district-nexus' || pathname === '/intelligence/district-nexus/';
}
