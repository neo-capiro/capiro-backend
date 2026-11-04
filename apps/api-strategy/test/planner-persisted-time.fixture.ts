import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  type PlannerTimeOptions,
  type PlannerTimesheetData,
} from '@capiro/strategy-verifier';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/** Seed historical configuration directly; the retired management APIs are not test setup APIs. */
export async function seedTimeSettings(
  db: PrismaService,
  ctx: AuthTenantContext,
  input: { reviewers?: Record<string, string>; options?: Partial<PlannerTimeOptions> },
) {
  return db.withTenant(ctx.tenantId, async (tx) => {
    const old = await tx.spPlannerResource.findFirst({
      where: { tenantId: ctx.tenantId, kind: 'time_settings' },
    });
    const previous = old?.data as
      { reviewers?: Record<string, string>; options?: Partial<PlannerTimeOptions> } | undefined;
    const data = {
      reviewers: input.reviewers ?? previous?.reviewers ?? {},
      options: { ...PLANNER_DEFAULT_TIME_OPTIONS, ...previous?.options, ...input.options },
    } as Prisma.InputJsonValue;
    return old
      ? tx.spPlannerResource.update({
          where: { id: old.id, tenantId: ctx.tenantId },
          data: { data, version: { increment: 1 } },
        })
      : tx.spPlannerResource.create({
          data: {
            tenantId: ctx.tenantId,
            ownerId: ctx.clerkUserId,
            kind: 'time_settings',
            name: 'Persisted time settings fixture',
            data,
          },
        });
  });
}

export function storedTimesheet(db: PrismaService, ctx: AuthTenantContext, weekOn: string) {
  return db.withTenant(ctx.tenantId, (tx) =>
    tx.spPlannerResource.findFirst({
      where: {
        tenantId: ctx.tenantId,
        kind: 'timesheet',
        ownerId: ctx.clerkUserId,
        data: { path: ['weekOn'], equals: weekOn },
      },
    }),
  );
}

/** Fixture states only: this deliberately implements no retired transition or authorization logic. */
export async function seedTimesheet(
  db: PrismaService,
  ctx: AuthTenantContext,
  weekOn: string,
  state: Partial<PlannerTimesheetData>,
) {
  const old = await storedTimesheet(db, ctx, weekOn);
  const data = {
    weekOn,
    reviewerId: null,
    status: 'draft',
    notes: '',
    correctedAfterApproval: false,
    ...(old?.data as object | undefined),
    ...state,
  } as unknown as Prisma.InputJsonValue;
  return db.withTenant(ctx.tenantId, (tx) =>
    old
      ? tx.spPlannerResource.update({
          where: { id: old.id, tenantId: ctx.tenantId },
          data: { data, version: { increment: 1 } },
        })
      : tx.spPlannerResource.create({
          data: {
            tenantId: ctx.tenantId,
            ownerId: ctx.clerkUserId,
            kind: 'timesheet',
            name: 'Persisted weekly lock fixture',
            data,
          },
        }),
  );
}
