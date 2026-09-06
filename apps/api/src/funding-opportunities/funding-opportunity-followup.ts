import { BadRequestException } from '@nestjs/common';

/** Merge a partial team-plan edit after reading the workflow under its row lock. */
export function fundingFollowupPatch(
  input: { nextAction?: string | null; nextActionDueAt?: string | null },
  existing: { nextAction?: string | null; nextActionDueAt?: Date | null } | null,
): { nextAction?: string | null; nextActionDueAt?: Date | null } {
  const nextAction =
    input.nextAction === undefined
      ? (existing?.nextAction ?? null)
      : input.nextAction?.trim() || null;
  const patch: { nextAction?: string | null; nextActionDueAt?: Date | null } = {};
  if (input.nextAction !== undefined) {
    patch.nextAction = nextAction;
    if (!nextAction) patch.nextActionDueAt = null;
  }
  if (input.nextActionDueAt !== undefined) {
    const dueAt = input.nextActionDueAt === null ? null : new Date(input.nextActionDueAt);
    if (dueAt && Number.isNaN(dueAt.getTime()))
      throw new BadRequestException('nextActionDueAt must be an ISO-8601 timestamp.');
    if (dueAt && !nextAction)
      throw new BadRequestException('A follow-up date needs a next action.');
    patch.nextActionDueAt = dueAt;
  }
  return patch;
}
