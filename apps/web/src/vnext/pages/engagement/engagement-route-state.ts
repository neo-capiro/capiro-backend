/**
 * vNext Engagement route state — STAGED ROLLOUT (foundations phase,
 * 2026-08-16).
 *
 * Adapted from `origin/agent/engagement-complete-gpt56`'s route-state module
 * (`git show origin/agent/engagement-complete-gpt56:apps/web/src/vnext/pages/engagement/engagement-route-state.ts`),
 * which assumed all four Engagement destinations already had native vNext
 * bodies. On this branch only Outreach does (`VNextOutreachWorkspace`,
 * shipped before this phase) — `VNextMeetingsWorkspace`, `VNextMeetingLibrary`
 * and its Reports counterpart are built in later phases of this navy reskin.
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
 * Staged-rollout switchboard. Flip an entry to `true` once its real vNext
 * component exists and is wired into `VNextEngagementRoutes`' render switch —
 * no other change to the interception contract (this file or VNextRouter.tsx)
 * is required.
 *
 *   - outreach: LIVE — VNextOutreachWorkspace (shipped before this phase).
 *   - meetings, library, reports: PENDING — canonical EngagementPage keeps
 *     rendering these on both domains until each gets its own vNext body.
 */
const ENGAGEMENT_DESTINATION_READY: Record<EngagementDestination, boolean> = {
  meetings: false,
  library: false,
  outreach: true,
  reports: false,
};

/**
 * Which of the four Engagement surfaces a pathname renders. Pure URL logic —
 * independent of rollout status, so it keeps working unchanged as each
 * destination gets promoted to `true` above.
 */
export function engagementDestination(pathname: string): EngagementDestination {
  if (pathname === '/engagement/meetings/library') return 'library';
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
 * meetings`, `/engagement/meetings/library` and `/engagement/reports` all
 * stay canonical (unchanged) until Meetings/Library/Reports ship their own
 * vNext bodies.
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

  if (pathname.startsWith(MEETING_DETAIL_PREFIX) && pathname !== '/engagement/meetings/library') {
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
