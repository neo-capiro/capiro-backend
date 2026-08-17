/**
 * vNext Engagement route state — STAGED ROLLOUT (Library phase, 2026-08-16).
 *
 * Adapted from `origin/agent/engagement-complete-gpt56`'s route-state module
 * (`git show origin/agent/engagement-complete-gpt56:apps/web/src/vnext/pages/engagement/engagement-route-state.ts`),
 * which assumed all four Engagement destinations already had native vNext
 * bodies. On this branch, Outreach (`VNextOutreachWorkspace`), Meetings
 * (`VNextMeetingsWorkspace`) and now Library (`VNextMeetingLibrary`, this
 * phase) do — Reports is built in a later phase of this navy reskin.
 *
 * `engagementDestination` and `canonicalEngagementLocation` are unchanged,
 * pure URL logic, ported as-is from that reference. `isVNextEngagementPath`
 * is new: it additionally gates on `ENGAGEMENT_DESTINATION_READY` so
 * `VNextRouter` only claims the destinations that actually have a component
 * to render — the same contract `isVNextDirectoryPath` uses today (see
 * `VNextDirectoryRoutes.tsx`: "the route is only claimed once its surface is
 * ready").
 */

export type EngagementDestination = 'meetings' | 'library' | 'outreach' | 'reports';

const MEETING_DETAIL_PREFIX = '/engagement/meetings/';

/**
 * The REAL Meeting Library route — a flat sibling of `/engagement/meetings`,
 * not nested under it. Matches routeManifest.ts's `engagement-library` entry
 * and the literal path EngagementPage.tsx's URL writer navigates to. (Bug fix,
 * 2026-08-16: `engagementDestination` previously checked the nested shape
 * `/engagement/meetings/library`, which no route in the app ever produces —
 * harmless only because ENGAGEMENT_DESTINATION_READY.meetings was false, so
 * every meetings-shaped path fell through to canonical regardless. Promoting
 * Meetings to `true` this phase would otherwise make the real Library URL
 * silently misclassify as the `meetings` destination and get claimed by
 * vNext instead of falling through to the still-canonical Library page.)
 */
const LIBRARY_PATH = '/engagement/meeting-library';

/**
 * Staged-rollout switchboard. Flip an entry to `true` once its real vNext
 * component exists and is wired into `VNextEngagementRoutes`' render switch —
 * no other change to the interception contract (this file or VNextRouter.tsx)
 * is required.
 *
 *   - outreach: LIVE — VNextOutreachWorkspace (shipped before this phase).
 *   - meetings: LIVE — VNextMeetingsWorkspace (Meetings phase, 2026-08-16).
 *   - library: LIVE — VNextMeetingLibrary (Library phase, 2026-08-16).
 *   - reports: LIVE — VNextReportsTracker (Reports phase, 2026-08-16).
 */
const ENGAGEMENT_DESTINATION_READY: Record<EngagementDestination, boolean> = {
  meetings: true,
  library: true,
  outreach: true,
  reports: true,
};

/**
 * Which of the four Engagement surfaces a pathname renders. Pure URL logic —
 * independent of rollout status, so it keeps working unchanged as each
 * destination gets promoted to `true` above.
 */
export function engagementDestination(pathname: string): EngagementDestination {
  if (pathname === LIBRARY_PATH) return 'library';
  if (pathname.startsWith('/engagement/outreach')) return 'outreach';
  if (pathname.startsWith('/engagement/reports')) return 'reports';
  return 'meetings';
}

/**
 * Whether vNext claims this Engagement pathname. `VNextRouter` uses this to
 * decide between rendering `VNextEngagementRoutes` and falling through to the
 * canonical page — the same contract `isVNextDirectoryPath` /
 * `isVNextLegiWatchPath` use for their own modules. A path only counts once
 * its destination is marked ready above, so `/engagement`, `/engagement/
 * meetings` and `/engagement/meeting-library` are now all claimed by vNext
 * (VNextMeetingsWorkspace / VNextMeetingLibrary), while `/engagement/reports`
 * stays canonical (unchanged) until Reports ships its own vNext body.
 */
export function isVNextEngagementPath(pathname: string): boolean {
  if (!(pathname === '/engagement' || pathname.startsWith('/engagement/'))) return false;
  return ENGAGEMENT_DESTINATION_READY[engagementDestination(pathname)];
}

/**
 * Normalizes legacy query-string/path shapes onto the current contract (a
 * copied `?view=calendar` link, the old `?detail=` param name, or a bare
 * meeting-id path segment) onto `/engagement/meetings?...`. Returns `null`
 * when nothing needs to change.
 *
 * Ported as-is from the reference branch. Today only Outreach is claimed,
 * and Outreach doesn't use `view`, `detail`, or the bare `/engagement` /
 * `/engagement/meetings/:id` shapes this canonicalizes — so in practice this
 * is inert until Meetings/Library are promoted. It's kept live (wired into
 * `VNextEngagementRoutes`' redirect effect) rather than deleted, so that
 * promotion doesn't also require reintroducing URL-compat logic from
 * scratch.
 */
export function canonicalEngagementLocation(pathname: string, search: string): string | null {
  if (pathname === '/engagement' || pathname === '/engagement/overview') {
    return '/engagement/meetings';
  }

  if (pathname.startsWith(MEETING_DETAIL_PREFIX) && pathname !== LIBRARY_PATH) {
    const rawId = pathname.slice(MEETING_DETAIL_PREFIX.length).split('/')[0] ?? '';
    if (!rawId) return '/engagement/meetings';
    const params = new URLSearchParams(search);
    params.set('meeting', decodeURIComponent(rawId));
    const legacyDetail = params.get('detail');
    if (legacyDetail && !params.has('tab')) params.set('tab', legacyDetail);
    params.delete('detail');
    if (params.get('view') === 'calendar') params.set('view', 'month');
    const serialized = params.toString();
    return `/engagement/meetings${serialized ? `?${serialized}` : ''}`;
  }

  const params = new URLSearchParams(search);
  let changed = false;
  if (params.get('view') === 'calendar') {
    params.set('view', 'month');
    changed = true;
  }
  const legacyDetail = params.get('detail');
  if (legacyDetail && !params.has('tab')) {
    params.set('tab', legacyDetail);
    params.delete('detail');
    changed = true;
  }
  if (!changed) return null;
  const serialized = params.toString();
  return `${pathname}${serialized ? `?${serialized}` : ''}`;
}
