/**
 * Pure selection logic for scheduled proactive meeting briefings (P2-8).
 *
 * A scheduled job briefs each user about clients with meetings coming up in the
 * lookahead window, only for meetings that NEWLY entered the window since the
 * last run (so the same meeting isn't re-briefed every day). This module is the
 * testable core; the job (scripts/generate-meeting-briefings.ts) handles the I/O
 * (query meetings, generate the digest, deliver to inbox + email).
 *
 * Pure (no I/O) so it unit-tests under `src/**.spec.ts`.
 */

export interface UpcomingMeeting {
  id: string;
  userId: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  startsAt: Date;
  /** IANA timezone from the meeting record, when known. */
  timeZone?: string | null;
}

export interface BriefingSelectionOptions {
  now: Date;
  lookaheadDays: number;
  /** End of the previous run's window basis; null on first run. */
  lastRunAt: Date | null;
}

export interface UserBriefingPlan {
  userId: string;
  meetings: UpcomingMeeting[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A meeting is briefed when it is upcoming and within the lookahead window now,
 * AND it was beyond the window at the last run (newly entered) — or this is the
 * first run. Returns one plan per user (with >=1 meeting), sorted by soonest.
 */
export function selectMeetingBriefings(
  meetings: UpcomingMeeting[],
  opts: BriefingSelectionOptions,
): UserBriefingPlan[] {
  const nowMs = opts.now.getTime();
  const windowEnd = nowMs + Math.max(0, opts.lookaheadDays) * DAY_MS;
  const lastWindowEnd = opts.lastRunAt
    ? opts.lastRunAt.getTime() + opts.lookaheadDays * DAY_MS
    : null;

  const selected = meetings.filter((m) => {
    const t = m.startsAt.getTime();
    if (Number.isNaN(t)) return false;
    if (t < nowMs || t > windowEnd) return false; // not in the current window
    if (lastWindowEnd != null && t <= lastWindowEnd) return false; // already in window last run
    return true;
  });

  const byUser = new Map<string, UpcomingMeeting[]>();
  for (const m of selected) {
    const list = byUser.get(m.userId) ?? [];
    list.push(m);
    byUser.set(m.userId, list);
  }

  return [...byUser.entries()].map(([userId, list]) => ({
    userId,
    meetings: list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  }));
}

/** Plain-text digest of a user's upcoming meetings for the briefing body/email. */
export function formatBriefingDigest(plan: UserBriefingPlan): string {
  const lines = ['Upcoming meetings that need prep:', ''];
  for (const m of plan.meetings) {
    const rawTz = (m.timeZone ?? '').trim();
    const tz = rawTz && rawTz.toUpperCase() !== 'UTC' ? rawTz : 'America/New_York';
    const when = m.startsAt.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    });
    const who = m.clientName ? ` — ${m.clientName}` : '';
    lines.push(`• ${when}: ${m.title}${who}`);
  }
  return lines.join('\n');
}
