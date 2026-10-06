/** Preparing a stream is not permission to record hours before a proceeding.
 * Unknown scheduled times remain waiting; an officially in-progress event can
 * start immediately even when its scheduled timestamp is missing or stale. */
export function captureDeferredUntil(
  hearing: { scheduledStart?: Date; eventStatus: string; publicAccess: string },
  now: Date,
): Date | null {
  const status = hearing.eventStatus.trim().toUpperCase();
  if (
    hearing.publicAccess.trim().toUpperCase() !== 'PUBLIC' ||
    ['CANCELED', 'CANCELLED', 'POSTPONED', 'COMPLETED', 'IN_PROGRESS'].includes(status)
  )
    return null; // Existing access/terminal/live policy takes precedence.
  const start = hearing.scheduledStart?.getTime();
  if (!Number.isFinite(start)) return new Date(now.getTime() + 5 * 60_000);
  const due = start! - 5 * 60_000;
  return due > now.getTime() ? new Date(due) : null;
}
