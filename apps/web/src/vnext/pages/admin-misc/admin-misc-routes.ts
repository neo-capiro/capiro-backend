/**
 * Admin + misc vNext — path predicate for VNextRouter, in its own UI-free
 * module (same pattern as settings-route.ts / district-nexus-route.ts) so the
 * router and its tests can consult the claim without pulling the page tree
 * into the eager bundle.
 *
 * The module claims EXACTLY these six canonical paths (purge Phase 3):
 *
 *   /admin/analyst-console                  — unified analyst console (capiro_admin)
 *   /admin/program-element/reconciliation   — cross-source reconciliation queue
 *   /admin/program-element/match-queue      — PE→Program match review queue
 *   /actions                                — the §12.4 action board
 *   /reviews                                — the §3.3 reviewer queue
 *   /help                                   — the help center
 *
 * Deliberately NOT claimed: `/admin`, `/admin/<anything else>` and
 * `/capiro-admin` are canonical `<Navigate>` redirects into /settings (App.tsx
 * back-compat block) — no UI renders there, so they must keep falling through
 * to the canonical redirect, which then lands on /settings/... and is claimed
 * by the Settings vNext module. Matching is exact-path, so the /admin/*
 * fallthrough stays intact for every other admin URL.
 */
const ADMIN_MISC_PATHS = new Set([
  '/admin/analyst-console',
  '/admin/program-element/reconciliation',
  '/admin/program-element/match-queue',
  '/actions',
  '/reviews',
  '/help',
]);

export function isVNextAdminMiscPath(pathname: string): boolean {
  // Tolerate a single trailing slash the way <Route path> matching does.
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return ADMIN_MISC_PATHS.has(normalized);
}
