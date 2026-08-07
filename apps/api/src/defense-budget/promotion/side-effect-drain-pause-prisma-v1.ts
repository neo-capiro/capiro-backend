/**
 * Phase 7 Workstream L — the drain pause state, in one place.
 *
 * Two callers need this table and they must not disagree about it. Workstream
 * E's `rollback()` pauses the drain before it moves the active pointer; the
 * drainer reads the same state before it claims a batch. If those two grew
 * separate copies of "what paused means", the failure would be silent and would
 * only show up as a snapshot's changes being announced after that snapshot
 * stopped being active — which is the exact scenario the pause exists to
 * prevent, so it would look like the pause simply had not worked.
 *
 * Pausing is an upsert rather than an insert. A rollback can follow a rollback,
 * and the second one must not fail on a unique violation at the moment the
 * operator most needs it to work.
 */

/** The Prisma delegate this module needs, declared structurally so a test can fake it. */
export interface DrainPauseDelegateV1 {
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  upsert(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

/**
 * Whether the drain is paused for this scope.
 *
 * No row means not paused. That is the deliberate default: a database that has
 * never been paused must not refuse to drain, and an environment nobody has
 * rolled back has no pause row.
 */
export async function isDrainPausedV1(
  delegate: DrainPauseDelegateV1,
  domain: string,
  environment: string,
): Promise<boolean> {
  const row = await delegate.findUnique({
    where: { domain_environment: { domain, environment } },
    select: { paused: true },
  });
  return row?.paused === true;
}

export async function pauseDrainV1(
  delegate: DrainPauseDelegateV1,
  input: { domain: string; environment: string; reason: string; pausedBy: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await delegate.upsert({
    where: { domain_environment: { domain: input.domain, environment: input.environment } },
    create: {
      domain: input.domain,
      environment: input.environment,
      paused: true,
      reason: input.reason,
      pausedBy: input.pausedBy,
      pausedAt: now,
      updatedAt: now,
    },
    update: {
      paused: true,
      reason: input.reason,
      pausedBy: input.pausedBy,
      pausedAt: now,
      // Cleared together with `paused`, because the resume check constraint
      // refuses a paused row that still claims to have been resumed.
      resumedBy: null,
      resumedAt: null,
      updatedAt: now,
    },
  });
}

/**
 * Resume, if paused.
 *
 * `updateMany` guarded on `paused: true` rather than `update`: resuming a scope
 * that was never paused is a no-op, not an error. An operator running resume
 * defensively after an incident should not get a failure telling them the
 * system is already in the state they wanted.
 */
export async function resumeDrainV1(
  delegate: DrainPauseDelegateV1,
  input: { domain: string; environment: string; resumedBy: string; now?: Date },
): Promise<{ resumed: boolean }> {
  const now = input.now ?? new Date();
  const result = await delegate.updateMany({
    where: { domain: input.domain, environment: input.environment, paused: true },
    data: { paused: false, resumedBy: input.resumedBy, resumedAt: now, updatedAt: now },
  });
  return { resumed: result.count > 0 };
}
