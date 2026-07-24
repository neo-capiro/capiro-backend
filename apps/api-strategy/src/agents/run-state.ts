/*
 * Stage C run/mission lifecycle state machines. PURE module (no Nest imports):
 * assert helpers throw plain Errors; the services wrap illegal transitions in
 * BadRequestException. Mirrors the SpRunState / SpMissionState Prisma enums —
 * the schema is authoritative for the value sets; this module is authoritative
 * for which moves between them are legal.
 */

export const RUN_STATES = [
  'queued',
  'planning',
  'waiting_for_input',
  'executing',
  'ready_for_review',
  'completed',
  'failed',
  'canceled',
] as const;
export type RunStateValue = (typeof RUN_STATES)[number];

export const MISSION_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const;
export type MissionStateValue = (typeof MISSION_STATES)[number];

/** Legal run-state moves. completed/failed/canceled are terminal. */
export const RUN_TRANSITIONS: Record<RunStateValue, readonly RunStateValue[]> = {
  queued: ['planning', 'canceled'],
  planning: ['executing', 'waiting_for_input', 'failed', 'canceled'],
  waiting_for_input: ['planning', 'executing', 'failed', 'canceled'],
  executing: ['ready_for_review', 'waiting_for_input', 'failed', 'canceled'],
  ready_for_review: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

/**
 * Legal mission-state moves. completed/failed/canceled are terminal. `failed`
 * is reachable from active/paused (e.g. the scheduler failing a mission after
 * repeated run failures) — never from draft, which cancels instead.
 */
export const MISSION_TRANSITIONS: Record<MissionStateValue, readonly MissionStateValue[]> = {
  draft: ['active', 'canceled'],
  active: ['paused', 'completed', 'failed', 'canceled'],
  paused: ['active', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export const RUN_TERMINAL_STATES: ReadonlySet<string> = new Set(
  RUN_STATES.filter((s) => RUN_TRANSITIONS[s].length === 0),
);

export function isLegalTransition(from: string, to: string): boolean {
  const allowed = (RUN_TRANSITIONS as Record<string, readonly string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Throws a plain Error on an illegal run transition (service wraps in 400). */
export function assertTransition(from: string, to: string): void {
  if (!isLegalTransition(from, to)) {
    const allowed = (RUN_TRANSITIONS as Record<string, readonly string[]>)[from];
    throw new Error(
      allowed === undefined
        ? `Unknown run state '${from}'`
        : allowed.length === 0
          ? `Run is ${from} (terminal) — no further transitions`
          : `Cannot transition run from '${from}' to '${to}' (allowed: ${allowed.join(', ')})`,
    );
  }
}

export function isLegalMissionTransition(from: string, to: string): boolean {
  const allowed = (MISSION_TRANSITIONS as Record<string, readonly string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Throws a plain Error on an illegal mission transition (service wraps in 400). */
export function assertMissionTransition(from: string, to: string): void {
  if (!isLegalMissionTransition(from, to)) {
    const allowed = (MISSION_TRANSITIONS as Record<string, readonly string[]>)[from];
    throw new Error(
      allowed === undefined
        ? `Unknown mission state '${from}'`
        : allowed.length === 0
          ? `Mission is ${from} (terminal) — no further transitions`
          : `Cannot transition mission from '${from}' to '${to}' (allowed: ${allowed.join(', ')})`,
    );
  }
}
