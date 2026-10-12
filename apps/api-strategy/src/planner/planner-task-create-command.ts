import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { SpPlannerResource } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { keys, object, uuid } from './planner.validation.js';

export const TASK_CREATE_RECEIPT = 'task_create_receipt';
export type TaskCreateCommand = { requestId: string; hash: string };

// Hash JSON with stable object-key order, preserving array order and explicit nulls.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function taskCreateCommand(raw: unknown) {
  const input = object(raw);
  keys(input, ['requestId', 'data']);
  const requestId = uuid(input.requestId).toLowerCase();
  const data = object(input.data);
  return {
    data,
    command: {
      requestId,
      hash: createHash('sha256')
        .update(JSON.stringify(canonical(data)))
        .digest('hex'),
    },
  };
}
export function taskCreateReceiptWhere(ctx: AuthTenantContext, requestId: string) {
  return {
    tenantId: ctx.tenantId,
    ownerId: ctx.clerkUserId,
    kind: TASK_CREATE_RECEIPT,
    data: { path: ['requestId'], equals: requestId },
  };
}
export function storedTaskCreateReceipt(
  row: SpPlannerResource,
  ctx: AuthTenantContext,
  requestId: string,
) {
  const data = object(row.data);
  if (
    row.tenantId !== ctx.tenantId ||
    row.ownerId !== ctx.clerkUserId ||
    row.kind !== TASK_CREATE_RECEIPT ||
    data.requestId !== requestId ||
    data.receiptVersion !== 1 ||
    typeof data.hash !== 'string'
  )
    throw new NotFoundException('Planner record not found');
  return { taskId: uuid(data.taskId), hash: data.hash };
}
export function taskCreateReceipt(requestId: string, taskId: string) {
  return { requestId, status: 'completed' as const, taskId };
}
