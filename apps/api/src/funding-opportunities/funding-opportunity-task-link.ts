import type { Prisma } from '@prisma/client';
import type { InboxSource } from './funding-opportunity-inbox.service.js';

export const FUNDING_OPPORTUNITY_TASK_SOURCE = 'funding_opportunity';
type TaskIntent = 'review' | 'pursuit';

export function fundingOpportunityTaskSourceId(
  clientId: string,
  source: InboxSource,
  sourceRecordId: string,
  intent: TaskIntent,
): string {
  return `v2:${clientId}:${source}:${encodeURIComponent(sourceRecordId)}:${intent}`;
}

/** Current identity first; old identities are safe only with the actual client. */
export async function findFundingOpportunityTask(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    clientId: string;
    source: InboxSource;
    sourceRecordId: string;
    intent: TaskIntent;
  },
) {
  const scope = {
    tenantId: input.tenantId,
    clientId: input.clientId,
    sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
  };
  const select = { id: true, title: true, ownerUserId: true, dueDate: true } as const;
  return (
    (await tx.engagementTask.findFirst({
      where: {
        ...scope,
        sourceId: fundingOpportunityTaskSourceId(
          input.clientId,
          input.source,
          input.sourceRecordId,
          input.intent,
        ),
      },
      select,
    })) ??
    (await tx.engagementTask.findFirst({
      where: { ...scope, sourceId: `${input.source}:${input.sourceRecordId}:${input.intent}` },
      select,
    }))
  );
}

/** Keep explicit workflow edits aligned with an existing same-client task. */
export async function syncExistingFundingActionTask(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    clientId: string;
    source: InboxSource;
    sourceRecordId: string;
    intent: TaskIntent;
    ownerUserId?: string | null;
    nextAction?: string | null;
    nextActionDueAt?: Date | null;
  },
): Promise<void> {
  const title = input.nextAction?.trim();
  const data = {
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.nextActionDueAt !== undefined ? { dueDate: input.nextActionDueAt } : {}),
    ...(title ? { title: title.slice(0, 240) } : {}),
  };
  if (!Object.keys(data).length) return;
  const task = await findFundingOpportunityTask(tx, input);
  if (!task) return;
  await tx.engagementTask.updateMany({
    where: {
      id: task.id,
      tenantId: input.tenantId,
      clientId: input.clientId,
      sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
    },
    data,
  });
}
