import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  clientMemoryAllowed,
  clientMemoryAllowedForRowOwnerSql,
} from '../memory/memory-wall.helpers.js';

export const SCHEDULED_TASK_LEASE_MS = 120_000;
export const SCHEDULED_TASK_HEARTBEAT_MS = 10_000;
export const SCHEDULED_TASK_MAX_ATTEMPTS = 3;

export type ScheduledTaskExecutionBoundary =
  'runnable' | 'inactive' | 'authority_denied' | 'wall_denied' | 'lease_lost';

export interface ScheduledTaskIdentity {
  id: string;
  tenantId: string;
  ownerUserId: string;
}

export type ScheduledTaskExecutionStage =
  | 'claimed'
  | 'research_started'
  | 'result_saved'
  | 'email_started'
  | 'email_confirmed'
  | 'email_unknown'
  | 'recovery_unknown'
  | 'completed';

export interface ScheduledTaskNotificationReceipt {
  requested: boolean;
  recipient: string | null;
  outcome: 'pending' | 'not_requested' | 'unknown' | 'confirmed';
  startedAt?: string;
  confirmedAt?: string;
  error?: string;
  sentFrom?: string;
}

export interface ScheduledTaskDurableReceipt {
  version: 1;
  occurrenceId: string;
  scheduledFor: string;
  claimedAt: string;
  nextRunAt: string;
  fence: string;
  attempt: number;
  heartbeatAt: string;
  leaseExpiresAt: string;
  stage: ScheduledTaskExecutionStage;
  effectStartedAt?: string;
  completedAt?: string;
  result?: { alertId: string; savedAt: string };
  notification: ScheduledTaskNotificationReceipt;
}

export interface ScheduledTaskExecutionClaim {
  claimedAt: Date;
  nextRunAt: Date;
  occurrenceId: string;
  fence: string;
  receipt: ScheduledTaskDurableReceipt;
  recovered: boolean;
}

export interface ScheduledTaskObservedOccurrence {
  occurrenceId: string;
  fence: string;
}

export interface ScheduledTaskOwnerAuthority {
  role: string;
  clerkUserId: string;
  tenantSlug: string;
}

export type ScheduledTaskAuthorization =
  | { boundary: 'runnable'; authority: ScheduledTaskOwnerAuthority }
  | { boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> };

export type ScheduledTaskClaimResult =
  | { state: 'inactive' }
  | { state: 'already_running' }
  | { state: 'legacy_running_unknown' }
  | { state: 'ambiguous_effect'; stage: ScheduledTaskExecutionStage }
  | {
      state: 'notification_unknown';
      result: { alertId: string; savedAt: string } | null;
    }
  | {
      state: 'wall_denied' | 'authority_denied';
      claim: ScheduledTaskExecutionClaim;
    }
  | { state: 'claimed'; claim: ScheduledTaskExecutionClaim };

export type ScheduledTaskEffectResult<T> =
  | { executed: true; value: T }
  | { executed: false; boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> };

export type ScheduledTaskAuthorizedEffectResult<T> =
  | { executed: true; value: T; authority: ScheduledTaskOwnerAuthority }
  | { executed: false; boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> };

export interface ScheduledTaskSavedResult {
  alertId: string;
  text: string;
  toolsUsed: string[];
  notification: ScheduledTaskNotificationReceipt;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SCHEDULED_TASK_STAGES: readonly ScheduledTaskExecutionStage[] = [
  'claimed',
  'research_started',
  'result_saved',
  'email_started',
  'email_confirmed',
  'email_unknown',
  'recovery_unknown',
  'completed',
];

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function timestampToken(value: Date | string): string {
  if (typeof value === 'string') {
    if (!validTimestamp(value)) throw new Error('invalid scheduled task timestamp token');
    return value;
  }
  if (!Number.isFinite(value.getTime())) throw new Error('invalid scheduled task date');
  return value.toISOString();
}

export function parseScheduledTaskDurableReceipt(
  metadata: unknown,
): ScheduledTaskDurableReceipt | null {
  const root = record(metadata);
  const value = record(root?.scheduleExecution);
  const notification = record(value?.notification);
  const result = value?.result === undefined ? null : record(value.result);
  if (
    value?.version !== 1 ||
    typeof value.occurrenceId !== 'string' ||
    !validTimestamp(value.scheduledFor) ||
    !validTimestamp(value.claimedAt) ||
    !validTimestamp(value.nextRunAt) ||
    typeof value.fence !== 'string' ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !validTimestamp(value.heartbeatAt) ||
    !validTimestamp(value.leaseExpiresAt) ||
    !SCHEDULED_TASK_STAGES.includes(value.stage as ScheduledTaskExecutionStage) ||
    !notification ||
    typeof notification.requested !== 'boolean' ||
    !(notification.recipient === null || typeof notification.recipient === 'string') ||
    !['pending', 'not_requested', 'unknown', 'confirmed'].includes(String(notification.outcome)) ||
    (notification.startedAt !== undefined && !validTimestamp(notification.startedAt)) ||
    (notification.confirmedAt !== undefined && !validTimestamp(notification.confirmedAt)) ||
    (value.result !== undefined &&
      (!result || typeof result.alertId !== 'string' || !validTimestamp(result.savedAt)))
  )
    return null;

  return value as unknown as ScheduledTaskDurableReceipt;
}

function claimFromReceipt(
  receipt: ScheduledTaskDurableReceipt,
  recovered: boolean,
): ScheduledTaskExecutionClaim {
  return {
    claimedAt: new Date(receipt.claimedAt),
    nextRunAt: new Date(receipt.nextRunAt),
    occurrenceId: receipt.occurrenceId,
    fence: receipt.fence,
    receipt,
    recovered,
  };
}

function newReceipt(input: {
  claimedAt: Date;
  nextRunAt: Date;
  scheduledFor: Date | string;
  notificationRecipient: string | null;
}): ScheduledTaskDurableReceipt {
  const claimedAt = input.claimedAt.toISOString();
  return {
    version: 1,
    occurrenceId: randomUUID(),
    scheduledFor: timestampToken(input.scheduledFor),
    claimedAt,
    nextRunAt: input.nextRunAt.toISOString(),
    fence: randomUUID(),
    attempt: 1,
    heartbeatAt: claimedAt,
    leaseExpiresAt: new Date(input.claimedAt.getTime() + SCHEDULED_TASK_LEASE_MS).toISOString(),
    stage: 'claimed',
    notification: input.notificationRecipient
      ? {
          requested: true,
          recipient: input.notificationRecipient,
          outcome: 'pending',
        }
      : { requested: false, recipient: null, outcome: 'not_requested' },
  };
}

/** Resolve the current active owner, tenant, task, lease and client-wall authority. */
export async function authorizeScheduledTaskExecution(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim?: ScheduledTaskExecutionClaim,
): Promise<ScheduledTaskAuthorization> {
  const rows = await tx.$queryRawUnsafe<
    Array<{
      metadata: Prisma.JsonValue;
      role: string;
      clerk_user_id: string;
      tenant_slug: string;
    }>
  >(
    `SELECT st.metadata_jsonb AS metadata,
            tm.role::text AS role,
            u.clerk_user_id AS clerk_user_id,
            t.slug AS tenant_slug
       FROM clio_scheduled_task st
       JOIN tenant_memberships tm
         ON tm.tenant_id = st.tenant_id
        AND tm.user_id = st.owner_user_id
        AND tm.status = 'active'
       JOIN tenants t ON t.id = st.tenant_id AND t.status = 'active'
       JOIN users u ON u.id = st.owner_user_id
      WHERE st.id = $1::uuid
        AND st.tenant_id = $2::uuid
        AND st.owner_user_id = $3::uuid
        AND st.enabled = true
        AND ($4::text IS NULL OR (
          st.last_status = 'running'
          AND st.metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
          AND st.metadata_jsonb #>> '{scheduleExecution,fence}' = $5
          AND (st.metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
                > clock_timestamp()
        ))
      LIMIT 1`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim?.occurrenceId ?? null,
    claim?.fence ?? null,
  );
  const current = rows[0];
  if (!current) {
    const state = (
      await tx.$queryRawUnsafe<
        Array<{
          enabled: boolean;
          status: string | null;
          occurrence_id: string | null;
          fence: string | null;
          lease_expires_at: string | null;
          owner_active: boolean;
        }>
      >(
        `SELECT st.enabled,
              st.last_status AS status,
              st.metadata_jsonb #>> '{scheduleExecution,occurrenceId}' AS occurrence_id,
              st.metadata_jsonb #>> '{scheduleExecution,fence}' AS fence,
              st.metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}' AS lease_expires_at,
              EXISTS (
                SELECT 1
                  FROM tenant_memberships tm
                  JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
                 WHERE tm.tenant_id = st.tenant_id
                   AND tm.user_id = st.owner_user_id
                   AND tm.status = 'active'
              ) AS owner_active
         FROM clio_scheduled_task st
        WHERE st.id = $1::uuid
          AND st.tenant_id = $2::uuid
          AND st.owner_user_id = $3::uuid
        LIMIT 1`,
        task.id,
        task.tenantId,
        task.ownerUserId,
      )
    )[0];
    if (!state || !state.enabled || state.status !== 'running') {
      return { boundary: 'inactive' };
    }
    if (!state.owner_active) return { boundary: 'authority_denied' };
    if (claim) return { boundary: 'lease_lost' };
    return { boundary: 'inactive' };
  }

  const metadata = record(current.metadata) ?? {};
  const clientId = typeof metadata.clientId === 'string' ? metadata.clientId : null;
  if (clientId) {
    const client = await tx.client.findFirst({
      where: {
        id: clientId,
        tenantId: task.tenantId,
        status: { not: 'archived' },
      },
      select: { id: true },
    });
    if (!client) return { boundary: 'wall_denied' };
    if (!(await clientMemoryAllowed(tx, task.tenantId, task.ownerUserId, clientId))) {
      return { boundary: 'wall_denied' };
    }
  }

  return {
    boundary: 'runnable',
    authority: {
      role: current.role,
      clerkUserId: current.clerk_user_id,
      tenantSlug: current.tenant_slug,
    },
  };
}

export async function checkScheduledTaskExecutionBoundary(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim?: ScheduledTaskExecutionClaim,
): Promise<ScheduledTaskExecutionBoundary> {
  return (await authorizeScheduledTaskExecution(tx, task, claim)).boundary;
}

async function terminalizeExpiredReceipt(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  receipt: ScheduledTaskDurableReceipt,
  status: 'recovery_unknown' | 'notification_unknown',
): Promise<boolean> {
  const nextStage: ScheduledTaskExecutionStage =
    status === 'notification_unknown' ? 'email_unknown' : 'recovery_unknown';
  const notification =
    status === 'notification_unknown'
      ? { ...receipt.notification, outcome: 'unknown' as const }
      : receipt.notification;
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task
        SET last_status = $6,
            run_count = run_count + 1,
            metadata_jsonb = jsonb_set(
              jsonb_set(metadata_jsonb, '{scheduleExecution,stage}', to_jsonb($7::text), false),
              '{scheduleExecution,notification}', $8::jsonb, false
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    receipt.occurrenceId,
    receipt.fence,
    status,
    nextStage,
    JSON.stringify(notification),
  );
  return changed === 1;
}

/** Claim a new due occurrence or recover only the exact observed expired receipt. */
export async function claimScheduledTaskExecution(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claimedAt: Date,
  nextRunAt: Date,
  scheduledFor: Date | string = claimedAt,
  notificationRecipient: string | null = null,
  observedOccurrence: ScheduledTaskObservedOccurrence | null = null,
): Promise<ScheduledTaskClaimResult> {
  const scheduledForToken = timestampToken(scheduledFor);
  const receipt = newReceipt({
    claimedAt,
    nextRunAt,
    scheduledFor: scheduledForToken,
    notificationRecipient,
  });
  const rows = await tx.$queryRawUnsafe<Array<{ metadata: Prisma.JsonValue }>>(
    `UPDATE clio_scheduled_task
        SET last_run_at = $4::timestamptz,
            next_run_at = $5::timestamptz,
            last_status = 'running',
            metadata_jsonb = jsonb_set(
              COALESCE(metadata_jsonb, '{}'::jsonb),
              '{scheduleExecution}',
              $7::jsonb,
              true
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND next_run_at = $6::timestamptz
        AND next_run_at <= $4::timestamptz
        AND last_status IS DISTINCT FROM 'running'
      RETURNING metadata_jsonb AS metadata`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claimedAt,
    nextRunAt,
    scheduledForToken,
    JSON.stringify(receipt),
  );

  let activeReceipt = parseScheduledTaskDurableReceipt(rows[0]?.metadata);
  let recovered = false;
  if (!activeReceipt) {
    const current = (
      await tx.$queryRawUnsafe<
        Array<{
          status: string | null;
          metadata: Prisma.JsonValue;
          scheduled_for_matches: boolean;
        }>
      >(
        `SELECT last_status AS status,
              metadata_jsonb AS metadata,
              next_run_at = $4::timestamptz AS scheduled_for_matches
         FROM clio_scheduled_task
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND owner_user_id = $3::uuid
          AND enabled = true
        FOR UPDATE`,
        task.id,
        task.tenantId,
        task.ownerUserId,
        scheduledForToken,
      )
    )[0];
    if (!current) return { state: 'inactive' };
    if (current.status !== 'running') return { state: 'inactive' };
    const prior = parseScheduledTaskDurableReceipt(current.metadata);
    if (!prior) return { state: 'legacy_running_unknown' };
    if (
      !observedOccurrence ||
      !current.scheduled_for_matches ||
      observedOccurrence.occurrenceId !== prior.occurrenceId ||
      observedOccurrence.fence !== prior.fence
    ) {
      return { state: 'already_running' };
    }
    if (new Date(prior.leaseExpiresAt).getTime() > claimedAt.getTime()) {
      return { state: 'already_running' };
    }

    if (prior.stage === 'email_started' || prior.stage === 'email_unknown') {
      await terminalizeExpiredReceipt(tx, task, prior, 'notification_unknown');
      return { state: 'notification_unknown', result: prior.result ?? null };
    }
    if (prior.stage === 'research_started' || prior.stage === 'recovery_unknown') {
      await terminalizeExpiredReceipt(tx, task, prior, 'recovery_unknown');
      return { state: 'ambiguous_effect', stage: prior.stage };
    }
    if (prior.stage === 'completed') return { state: 'inactive' };
    if (prior.stage === 'claimed' && prior.attempt >= SCHEDULED_TASK_MAX_ATTEMPTS) {
      await terminalizeExpiredReceipt(tx, task, prior, 'recovery_unknown');
      return { state: 'ambiguous_effect', stage: 'recovery_unknown' };
    }

    const recoveredAt = claimedAt.toISOString();
    const replacement: ScheduledTaskDurableReceipt = {
      ...prior,
      fence: randomUUID(),
      attempt: prior.attempt + 1,
      heartbeatAt: recoveredAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + SCHEDULED_TASK_LEASE_MS).toISOString(),
    };
    const changed = await tx.$executeRawUnsafe(
      `UPDATE clio_scheduled_task
          SET metadata_jsonb = jsonb_set(
                metadata_jsonb, '{scheduleExecution}', $6::jsonb, false
              ),
              updated_at = clock_timestamp()
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND owner_user_id = $3::uuid
          AND enabled = true
          AND last_status = 'running'
          AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
          AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
          AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
                <= $7::timestamptz`,
      task.id,
      task.tenantId,
      task.ownerUserId,
      prior.occurrenceId,
      prior.fence,
      JSON.stringify(replacement),
      claimedAt,
    );
    if (changed !== 1) return { state: 'already_running' };
    activeReceipt = replacement;
    recovered = true;
  }

  const claim = claimFromReceipt(activeReceipt, recovered);
  const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
  if (authorization.boundary === 'runnable') return { state: 'claimed', claim };
  if (authorization.boundary === 'wall_denied') return { state: 'wall_denied', claim };
  if (authorization.boundary === 'authority_denied') {
    return { state: 'authority_denied', claim };
  }
  return { state: 'inactive' };
}

/** Recover a committed claim after the transaction acknowledgement was lost. */
export async function reconcileScheduledTaskClaim(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claimedAt: Date,
  scheduledFor: Date | string,
): Promise<ScheduledTaskExecutionClaim | null> {
  const row = (
    await tx.$queryRawUnsafe<Array<{ metadata: Prisma.JsonValue }>>(
      `SELECT metadata_jsonb AS metadata
       FROM clio_scheduled_task
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND last_run_at = $4::timestamptz
        AND metadata_jsonb #>> '{scheduleExecution,scheduledFor}' = $5::text
      LIMIT 1`,
      task.id,
      task.tenantId,
      task.ownerUserId,
      claimedAt,
      timestampToken(scheduledFor),
    )
  )[0];
  const receipt = parseScheduledTaskDurableReceipt(row?.metadata);
  return receipt ? claimFromReceipt(receipt, false) : null;
}

/** Renew only the exact active fence; membership/cancellation changes stop renewal. */
export async function renewScheduledTaskExecutionLease(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  heartbeatAt: Date = new Date(),
): Promise<boolean> {
  const leaseExpiresAt = new Date(heartbeatAt.getTime() + SCHEDULED_TASK_LEASE_MS);
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task st
        SET metadata_jsonb = jsonb_set(
              jsonb_set(
                st.metadata_jsonb,
                '{scheduleExecution,heartbeatAt}',
                to_jsonb($6::text),
                false
              ),
              '{scheduleExecution,leaseExpiresAt}',
              to_jsonb($7::text),
              false
            ),
            updated_at = clock_timestamp()
      WHERE st.id = $1::uuid
        AND st.tenant_id = $2::uuid
        AND st.owner_user_id = $3::uuid
        AND st.enabled = true
        AND st.last_status = 'running'
        AND st.metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND st.metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND (st.metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > $8::timestamptz
        AND EXISTS (
          SELECT 1
            FROM tenant_memberships tm
            JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
           WHERE tm.tenant_id = st.tenant_id
             AND tm.user_id = st.owner_user_id
             AND tm.status = 'active'
        )`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    heartbeatAt.toISOString(),
    leaseExpiresAt.toISOString(),
    heartbeatAt,
  );
  return changed === 1;
}

/** Persist the pre-provider ambiguity boundary before research can start. */
export async function markScheduledTaskResearchStarted(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  startedAt: Date = new Date(),
): Promise<boolean> {
  const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
  if (authorization.boundary !== 'runnable') return false;
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task
        SET metadata_jsonb = jsonb_set(
              jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,stage}',
                '"research_started"'::jsonb,
                false
              ),
              '{scheduleExecution,effectStartedAt}',
              to_jsonb($6::text),
              true
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND metadata_jsonb #>> '{scheduleExecution,stage}' = 'claimed'
        AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > clock_timestamp()`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    startedAt.toISOString(),
  );
  return changed === 1;
}

/** Atomically save the result alert and its durable result reference. */
export async function persistScheduledTaskResultAndAlert(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  input: { taskName: string; text: string; toolsUsed: string[]; savedAt?: Date },
): Promise<{ alertId: string; savedAt: string }> {
  const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
  if (authorization.boundary !== 'runnable') {
    throw new Error(`scheduled task result authority lost: ${authorization.boundary}`);
  }
  const savedAt = (input.savedAt ?? new Date()).toISOString();
  const alertId = claim.occurrenceId;
  const alertMetadata = {
    taskId: task.id,
    ownerUserId: task.ownerUserId,
    occurrenceId: claim.occurrenceId,
    runAt: claim.receipt.claimedAt,
    toolsUsed: input.toolsUsed,
    notificationOutcome: claim.receipt.notification.outcome,
  };
  await tx.$executeRawUnsafe(
    `INSERT INTO clio_proactive_alerts (
       id, tenant_id, owner_user_id, alert_type, title, body, priority,
       source_type, source_id, metadata_jsonb
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'scheduled_task', $4, $5, 'normal',
       'scheduled_task', $6, $7::jsonb
     )
     ON CONFLICT (id) DO NOTHING`,
    alertId,
    task.tenantId,
    task.ownerUserId,
    `Scheduled: ${input.taskName}`,
    input.text.slice(0, 8000),
    claim.occurrenceId,
    JSON.stringify(alertMetadata),
  );
  const exactAlert = (
    await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
       FROM clio_proactive_alerts
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND alert_type = 'scheduled_task'
        AND source_id = $4
      LIMIT 1`,
      alertId,
      task.tenantId,
      task.ownerUserId,
      claim.occurrenceId,
    )
  )[0];
  if (!exactAlert) throw new Error('scheduled task alert identity conflict');

  const result = { alertId, savedAt };
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task
        SET metadata_jsonb = jsonb_set(
              jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,result}',
                $6::jsonb,
                true
              ),
              '{scheduleExecution,stage}',
              '"result_saved"'::jsonb,
              false
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND metadata_jsonb #>> '{scheduleExecution,stage}' = 'research_started'
        AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > clock_timestamp()`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    JSON.stringify(result),
  );
  if (changed !== 1) throw new Error('scheduled task result fence lost');
  return result;
}

/** Load only the exact current alert referenced by the fenced occurrence. */
export async function readScheduledTaskSavedResult(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
): Promise<ScheduledTaskSavedResult | null> {
  const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
  if (authorization.boundary !== 'runnable') return null;
  const row = (
    await tx.$queryRawUnsafe<
      Array<{
        metadata: Prisma.JsonValue;
        id: string;
        body: string;
        alert_metadata: Prisma.JsonValue;
      }>
    >(
      `SELECT st.metadata_jsonb AS metadata,
            a.id,
            a.body,
            a.metadata_jsonb AS alert_metadata
       FROM clio_scheduled_task st
       JOIN clio_proactive_alerts a
         ON a.id::text = st.metadata_jsonb #>> '{scheduleExecution,result,alertId}'
        AND a.tenant_id = st.tenant_id
        AND a.owner_user_id = st.owner_user_id
        AND a.alert_type = 'scheduled_task'
        AND a.source_id = $4
      WHERE st.id = $1::uuid
        AND st.tenant_id = $2::uuid
        AND st.owner_user_id = $3::uuid
        AND st.enabled = true
        AND st.last_status = 'running'
        AND st.metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND st.metadata_jsonb #>> '{scheduleExecution,fence}' = $5
      LIMIT 1`,
      task.id,
      task.tenantId,
      task.ownerUserId,
      claim.occurrenceId,
      claim.fence,
    )
  )[0];
  const receipt = parseScheduledTaskDurableReceipt(row?.metadata);
  if (!row || !receipt?.result || receipt.result.alertId !== row.id) return null;
  const alertMetadata = record(row.alert_metadata);
  const toolsUsed = Array.isArray(alertMetadata?.toolsUsed)
    ? alertMetadata.toolsUsed.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    alertId: row.id,
    text: row.body,
    toolsUsed,
    notification: receipt.notification,
  };
}

/** Commit an unknown dispatch-started receipt before the external email call. */
export async function beginScheduledTaskEmailDispatch(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  startedAt: Date = new Date(),
): Promise<boolean> {
  const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
  if (authorization.boundary !== 'runnable') return false;
  const startedAtIso = startedAt.toISOString();
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task
        SET metadata_jsonb = jsonb_set(
              jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,stage}',
                '"email_started"'::jsonb,
                false
              ),
              '{scheduleExecution,notification}',
              jsonb_set(
                jsonb_set(
                  metadata_jsonb #> '{scheduleExecution,notification}',
                  '{outcome}',
                  '"unknown"'::jsonb,
                  false
                ),
                '{startedAt}',
                to_jsonb($6::text),
                true
              ),
              false
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND metadata_jsonb #>> '{scheduleExecution,stage}' = 'result_saved'
        AND metadata_jsonb #>> '{scheduleExecution,notification,requested}' = 'true'
        AND metadata_jsonb #>> '{scheduleExecution,notification,outcome}' = 'pending'
        AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > clock_timestamp()`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    startedAtIso,
  );
  if (changed !== 1) return false;
  const alertChanged = await tx.$executeRawUnsafe(
    `UPDATE clio_proactive_alerts
        SET metadata_jsonb = jsonb_set(
              jsonb_set(metadata_jsonb, '{notificationOutcome}', '"unknown"'::jsonb, true),
              '{notificationStartedAt}', to_jsonb($5::text), true
            )
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND source_id = $4`,
    claim.occurrenceId,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    startedAtIso,
  );
  if (alertChanged !== 1) throw new Error('scheduled task alert missing at email start');
  return true;
}

/** Persist provider confirmation or conservative unknown without completing the task. */
export async function recordScheduledTaskEmailOutcome(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  outcome: { confirmed: true; sentFrom?: string } | { confirmed: false; error?: string },
  observedAt: Date = new Date(),
): Promise<boolean> {
  const notificationPatch = {
    outcome: outcome.confirmed ? ('confirmed' as const) : ('unknown' as const),
    ...(outcome.confirmed === true
      ? { confirmedAt: observedAt.toISOString(), sentFrom: outcome.sentFrom }
      : { error: outcome.error?.slice(0, 500) ?? 'delivery outcome unknown' }),
  };
  const stage: ScheduledTaskExecutionStage = outcome.confirmed
    ? 'email_confirmed'
    : 'email_unknown';
  const rows = await tx.$queryRawUnsafe<Array<{ notification: Prisma.JsonValue }>>(
    `UPDATE clio_scheduled_task
        SET metadata_jsonb = jsonb_set(
              jsonb_set(
                metadata_jsonb,
                '{scheduleExecution,stage}',
                to_jsonb($6::text),
                false
              ),
              '{scheduleExecution,notification}',
              (metadata_jsonb #> '{scheduleExecution,notification}') || $7::jsonb,
              false
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND metadata_jsonb #>> '{scheduleExecution,stage}' IN ('email_started', 'email_unknown')
        AND metadata_jsonb #>> '{scheduleExecution,notification,startedAt}' IS NOT NULL
        AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > clock_timestamp()
      RETURNING metadata_jsonb #> '{scheduleExecution,notification}' AS notification`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    stage,
    JSON.stringify(notificationPatch),
  );
  const notification = record(rows[0]?.notification);
  if (!notification || !validTimestamp(notification.startedAt)) return false;
  const alertChanged = await tx.$executeRawUnsafe(
    `UPDATE clio_proactive_alerts
        SET metadata_jsonb = jsonb_set(
              jsonb_set(metadata_jsonb, '{notificationOutcome}', to_jsonb($5::text), true),
              '{notificationObservedAt}', to_jsonb($6::text), true
            )
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND source_id = $4`,
    claim.occurrenceId,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    notificationPatch.outcome,
    observedAt.toISOString(),
  );
  if (alertChanged !== 1) throw new Error('scheduled task alert missing at email outcome');
  return true;
}

/** Complete only the exact still-active claim. Cancellation and replacement win. */
export async function advanceScheduledTaskExecution(
  tx: Prisma.TransactionClient,
  task: ScheduledTaskIdentity,
  claim: ScheduledTaskExecutionClaim,
  status: string,
): Promise<boolean> {
  if (['ok', 'skipped_authority', 'skipped_wall'].includes(status)) {
    const authorization = await authorizeScheduledTaskExecution(tx, task, claim);
    if (status === 'ok' && authorization.boundary !== 'runnable') return false;
    if (status === 'skipped_authority' && authorization.boundary !== 'authority_denied') {
      return false;
    }
    if (status === 'skipped_wall' && authorization.boundary !== 'wall_denied') return false;
  }
  const changed = await tx.$executeRawUnsafe(
    `UPDATE clio_scheduled_task st
        SET last_status = $6::text,
            run_count = run_count + 1,
            metadata_jsonb = jsonb_set(
              jsonb_set(
                jsonb_set(
                  metadata_jsonb,
                  '{scheduleExecution,stage}',
                  '"completed"'::jsonb,
                  false
                ),
                '{scheduleExecution,completedAt}',
                to_jsonb(clock_timestamp()::text),
                true
              ),
              '{scheduleExecution,notification,outcome}',
              CASE WHEN $6::text = 'notification_unknown'
                THEN '"unknown"'::jsonb
                ELSE metadata_jsonb #> '{scheduleExecution,notification,outcome}'
              END,
              false
            ),
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND owner_user_id = $3::uuid
        AND enabled = true
        AND last_status = 'running'
        AND metadata_jsonb #>> '{scheduleExecution,occurrenceId}' = $4
        AND metadata_jsonb #>> '{scheduleExecution,fence}' = $5
        AND (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
              > clock_timestamp()
        AND (
          $6::text <> 'notification_unknown'
          OR (
            metadata_jsonb #>> '{scheduleExecution,stage}' IN ('email_started', 'email_unknown')
            AND metadata_jsonb #>> '{scheduleExecution,notification,outcome}' = 'unknown'
          )
        )
        AND (
          $6::text NOT IN ('ok', 'skipped_authority', 'skipped_wall')
          OR (
            $6::text = 'ok'
            AND metadata_jsonb #>> '{scheduleExecution,stage}' IN ('result_saved', 'email_confirmed')
            AND EXISTS (
              SELECT 1
                FROM tenant_memberships tm
                JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
                JOIN users u ON u.id = tm.user_id
               WHERE tm.tenant_id = st.tenant_id
                 AND tm.user_id = st.owner_user_id
                 AND tm.status = 'active'
            )
            AND (
              NULLIF(metadata_jsonb ->> 'clientId', '') IS NULL
              OR EXISTS (
                SELECT 1
                  FROM clients c
                 WHERE c.id::text = metadata_jsonb ->> 'clientId'
                   AND c.tenant_id = st.tenant_id
                   AND c.status <> 'archived'
                   AND (
                     ${clientMemoryAllowedForRowOwnerSql('c', 'st', 'owner_user_id')}
                   )
              )
            )
          )
          OR (
            $6::text = 'skipped_authority'
            AND NOT EXISTS (
              SELECT 1
                FROM tenant_memberships tm
                JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
                JOIN users u ON u.id = tm.user_id
               WHERE tm.tenant_id = st.tenant_id
                 AND tm.user_id = st.owner_user_id
                 AND tm.status = 'active'
            )
          )
          OR (
            $6::text = 'skipped_wall'
            AND NULLIF(metadata_jsonb ->> 'clientId', '') IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM tenant_memberships tm
                JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
                JOIN users u ON u.id = tm.user_id
               WHERE tm.tenant_id = st.tenant_id
                 AND tm.user_id = st.owner_user_id
                 AND tm.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM clients c
               WHERE c.id::text = metadata_jsonb ->> 'clientId'
                 AND c.tenant_id = st.tenant_id
                 AND c.status <> 'archived'
                 AND (
                   ${clientMemoryAllowedForRowOwnerSql('c', 'st', 'owner_user_id')}
                 )
            )
          )
        )`,
    task.id,
    task.tenantId,
    task.ownerUserId,
    claim.occurrenceId,
    claim.fence,
    status,
  );
  if (changed === 1 && status === 'notification_unknown') {
    const alertChanged = await tx.$executeRawUnsafe(
      `UPDATE clio_proactive_alerts
          SET metadata_jsonb = jsonb_set(
                metadata_jsonb,
                '{notificationOutcome}',
                '"unknown"'::jsonb,
                true
              )
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND owner_user_id = $3::uuid
          AND source_id = $4`,
      claim.occurrenceId,
      task.tenantId,
      task.ownerUserId,
      claim.occurrenceId,
    );
    if (alertChanged !== 1) throw new Error('scheduled task alert missing at unknown completion');
  }
  return changed === 1;
}

/** Check current claim authority immediately before invoking a controlled sink. */
export async function executeScheduledTaskEffect<T>(
  check: () => Promise<ScheduledTaskExecutionBoundary>,
  effect: () => Promise<T>,
): Promise<ScheduledTaskEffectResult<T>> {
  const boundary = await check();
  if (boundary !== 'runnable') return { executed: false, boundary };
  return { executed: true, value: await effect() };
}

/** Rebuild the actor context from current membership before every recovered operation. */
export async function executeAuthorizedScheduledTaskEffect<T>(
  authorize: () => Promise<ScheduledTaskAuthorization>,
  effect: (authority: ScheduledTaskOwnerAuthority) => Promise<T>,
): Promise<ScheduledTaskAuthorizedEffectResult<T>> {
  const authorization = await authorize();
  if (authorization.boundary !== 'runnable') {
    return { executed: false, boundary: authorization.boundary };
  }
  return {
    executed: true,
    value: await effect(authorization.authority),
    authority: authorization.authority,
  };
}
