import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
/**
 * Meri scheduled-task runner (W3 → W4: real read-only research).
 *
 * Executes DUE rows in clio_scheduled_task. Each task's prompt is run through an
 * AGENTIC loop that may call Meri's READ-ONLY research tools (the task's
 * tool_allow_list, defaulting to DEFAULT_SCHEDULED_TOOL_ALLOWLIST) — so a
 * scheduled "weekly bill brief" actually searches bills/awards/FARA/intel
 * against the tenant's data instead of free-associating. The result digest is
 * delivered to the in-app inbox (clio_proactive_alert) under the task's OWN
 * tenant. Side-effecting tools are NEVER attached (isAllowListSafe + the schema
 * filter below), so an unattended run can never email or write on a user's
 * behalf.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/run-clio-scheduled-tasks.ts --commit
 *
 * Intended cadence: hourly via EventBridge -> ECS run-task. The runner enforces
 * a 60-min per-task minimum, so hourly is the finest usable granularity. Tasks
 * with a clock-anchored time-of-day (metadata.runAtMinutesUtc) are re-pinned to
 * that wall-clock minute via computeNextRunAtAnchored.
 *
 * Multi-tenant safe: due rows are read via the system path, then each task runs
 * under a per-task TenantContext (owner user + tenant) so every tool read is
 * RLS-scoped to that tenant; delivery is written under the same tenant id.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { recordAiUsageEvent, parseProviderUsage, type TenantContext } from '@capiro/shared';
import type { ResolvedAiCredential } from '../src/ai-credentials/ai-credential-resolver.service.js';
import {
  computeNextRunAtAnchored,
  isAllowListSafe,
  DEFAULT_SCHEDULED_TOOL_ALLOWLIST,
} from '../src/meri/meri-schedule.helpers.js';
import {
  advanceScheduledTaskExecution,
  authorizeScheduledTaskExecution,
  beginScheduledTaskEmailDispatch,
  claimScheduledTaskExecution,
  executeAuthorizedScheduledTaskEffect,
  markScheduledTaskResearchStarted,
  persistScheduledTaskFailureAlert,
  persistScheduledTaskResultAndAlert,
  readScheduledTaskSavedResult,
  scheduledRunStopNote,
  reconcileScheduledTaskClaim,
  recordScheduledTaskEmailOutcome,
  renewScheduledTaskExecutionLease,
  SCHEDULED_TASK_HEARTBEAT_MS,
  type ScheduledTaskAuthorization,
  type ScheduledTaskExecutionBoundary,
  type ScheduledTaskExecutionClaim,
  type ScheduledTaskOwnerAuthority,
  type ScheduledTaskSavedResult,
} from '../src/meri/meri-schedule-execution-boundary.js';

dotenvConfig();

const DRY_RUN = !process.argv.includes('--commit');
const MAX_TASKS_PER_RUN = Number(process.env.CLIO_SCHEDULED_MAX_PER_RUN ?? '50');
// Bound the agentic loop so a runaway task can't loop or burn tokens unattended.
const MAX_ROUNDS = Number(process.env.CLIO_SCHEDULED_MAX_ROUNDS ?? '6');
const MAX_TOKENS = Number(process.env.CLIO_SCHEDULED_MAX_TOKENS ?? '1500');
const ANTHROPIC_VERSION = '2023-06-01';

interface DueTask {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  tool_allow_list: unknown;
  metadata_jsonb: unknown;
  next_run_at: Date;
  next_run_at_token: string;
  observed_occurrence_id: string | null;
  observed_fence: string | null;
}

type AuthorizedEffect = <T>(
  effect: (ctx: TenantContext) => Promise<T>,
) => Promise<
  | { executed: true; value: T; authority: ScheduledTaskOwnerAuthority }
  | { executed: false; boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> }
>;

type ScheduledResearchResult =
  | { text: string; toolsUsed: string[]; stopped?: 'provider_error' | 'round_cap' }
  | { blocked: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> }
  | null;

function isBlockedResearchResult(
  result: ScheduledResearchResult,
): result is { blocked: Exclude<ScheduledTaskExecutionBoundary, 'runnable'> } {
  return result !== null && 'blocked' in result;
}

export interface ScheduledTaskRunnerOptions {
  services?: { prisma: any; toolsService: any; aiCreds: any };
  commit?: boolean;
  now?: () => Date;
  research?: (input: {
    task: DueTask;
    executeAuthorized: AuthorizedEffect;
  }) => Promise<ScheduledResearchResult>;
  checkpoint?: (
    stage: 'claimed' | 'result_saved' | 'email_effect',
    input: { task: DueTask; claim: ScheduledTaskExecutionClaim },
  ) => Promise<void>;
}

function tenantContext(task: DueTask, authority: ScheduledTaskOwnerAuthority): TenantContext {
  return {
    tenantId: task.tenant_id,
    tenantSlug: authority.tenantSlug,
    userId: task.owner_user_id,
    clerkUserId: authority.clerkUserId,
    role: authority.role as TenantContext['role'],
  };
}

async function loadNest(): Promise<{
  AppModule: any;
  PrismaService: any;
  MeriToolsService: any;
  AiCredentialResolverService: any;
}> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      const tools = await import(`${base}/meri/meri-tools.service.js`);
      const cred = await import(`${base}/engagement/ai-credential-resolver.service.js`);
      return {
        AppModule: app.AppModule,
        PrismaService: prisma.PrismaService,
        MeriToolsService: tools.MeriToolsService,
        AiCredentialResolverService: cred.AiCredentialResolverService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

const SYSTEM_PROMPT =
  'You are Meri running a scheduled, unattended research task for a government-affairs ' +
  'team. You have READ-ONLY research tools — use them to ground every claim in the ' +
  "firm's actual data (clients, bills, awards, FARA, intel, dockets, etc.). Do not " +
  'invent facts: if a tool returns nothing, say so plainly. You cannot send email or ' +
  'write data, and must never claim to have taken an action. Produce a concise, ' +
  'scannable briefing (short headline + a few bullets). Finish with a one-line ' +
  '"Sources checked:" note listing the tools you used.';

/**
 * Run one task's prompt through a bounded agentic loop with the task's read-only
 * tools. Returns the final assistant text, or null on hard failure.
 */
async function runResearch(
  task: DueTask,
  toolsService: any,
  apiKey: string,
  model: string,
  usedTenantKey: boolean,
  allowList: string[],
  logger: Logger,
  prisma: any,
  executeAuthorized: AuthorizedEffect,
): Promise<ScheduledResearchResult> {
  // Filter the full Meri tool schema list to the task's allow-list, and harden:
  // never attach a tool that isn't read-only-safe (defense in depth on top of
  // isAllowListSafe, which we also check before calling this).
  const allowSet = new Set(allowList);
  const allSchemas: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> = toolsService.anthropicToolSchemas();
  const toolSchemas = allSchemas.filter(
    (s) => allowSet.has(s.name) && toolsService.isConcurrencySafe(s.name),
  );

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: task.prompt },
  ];
  const toolsUsed: string[] = [];
  let lastText = '';

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let json: any;
    try {
      const request = await executeAuthorized(() =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(
            prepareAnthropicRequest({
              model,
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              tools: toolSchemas,
              messages,
            }),
          ),
        }),
      );
      if (request.executed === false) return { blocked: request.boundary };
      const res = request.value;
      if (!res.ok) {
        logger.warn(
          `[task ${task.id}] anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
        return lastText ? { text: lastText, toolsUsed, stopped: 'provider_error' } : null;
      }
      json = await res.json();
    } catch (err) {
      logger.warn(`[task ${task.id}] anthropic call failed: ${(err as Error).message}`);
      return lastText ? { text: lastText, toolsUsed, stopped: 'provider_error' } : null;
    }

    // Phase 1 M5.0 (H-1): meter this round — one ai_usage_events row per
    // Anthropic call, same as the interactive chat/in-editor loops.
    // Once a provider request started, always meter its returned usage even if
    // cancellation arrived in flight. Cancellation cannot retract that call.
    await recordAiUsageEvent(
      { prisma, logger },
      { tenantId: task.tenant_id, userId: task.owner_user_id },
      'clio_scheduled_task',
      { provider: 'anthropic', model, usage: parseProviderUsage(json), usedTenantKey },
    );

    const content: Array<any> = Array.isArray(json.content) ? json.content : [];
    const textBlocks = content.filter((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length)
      lastText = textBlocks
        .map((b) => b.text)
        .join('\n')
        .trim();

    const toolUses = content.filter((b) => b.type === 'tool_use');
    // No tools requested → the turn is the final answer.
    if (json.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text: lastText, toolsUsed };
    }

    // Append the assistant turn (must replay the tool_use blocks verbatim).
    messages.push({ role: 'assistant', content });

    // Execute each requested tool in-process under the task's tenant context.
    const toolResults: Array<Record<string, unknown>> = [];
    for (const tu of toolUses) {
      const name = String(tu.name);
      const input = tu.input && typeof tu.input === 'object' ? tu.input : {};
      // Default clientId from the task metadata if the model omitted it.
      const meta =
        task.metadata_jsonb && typeof task.metadata_jsonb === 'object'
          ? (task.metadata_jsonb as Record<string, unknown>)
          : {};
      if (meta.clientId && (input as Record<string, unknown>).clientId === undefined) {
        (input as Record<string, unknown>).clientId = meta.clientId;
      }
      let payload: unknown;
      let isError = false;
      // Hard guard: refuse anything not in the read-only allow-list, even if the
      // model hallucinated a side-effecting tool name.
      if (!allowSet.has(name) || !toolsService.isConcurrencySafe(name)) {
        payload = { error: `Tool '${name}' is not permitted in a scheduled run.` };
        isError = true;
      } else {
        try {
          const execution = await executeAuthorized((currentCtx) =>
            toolsService.execute(currentCtx, name, input),
          );
          if (execution.executed === false) return { blocked: execution.boundary };
          payload = execution.value;
          toolsUsed.push(name);
        } catch (err) {
          payload = { error: (err as Error).message };
          isError = true;
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        is_error: isError,
        content: JSON.stringify(payload).slice(0, 20_000),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Hit the round cap — return whatever text we have (the model usually emits a
  // summary in the last text block before requesting more tools), marked as cut short.
  return lastText ? { text: lastText, toolsUsed, stopped: 'round_cap' } : null;
}

export async function runScheduledTasks(options: ScheduledTaskRunnerOptions = {}): Promise<void> {
  const logger = new Logger('run-meri-scheduled-tasks');
  let app: { get(token: any): any; close(): Promise<void> } | null = null;
  let services = options.services;
  if (!services) {
    const modules = await loadNest();
    app = await NestFactory.createApplicationContext(modules.AppModule, {
      logger: ['warn', 'error'],
    });
    services = {
      prisma: app.get(modules.PrismaService),
      toolsService: app.get(modules.MeriToolsService),
      aiCreds: app.get(modules.AiCredentialResolverService),
    };
  }
  const dryRun = options.commit === undefined ? DRY_RUN : !options.commit;
  const t0 = Date.now();
  try {
    const { prisma, toolsService, aiCreds } = services;

    const due: DueTask[] = await prisma.withSystem((tx: any) =>
      tx.$queryRawUnsafe(
        `SELECT id, tenant_id, owner_user_id, name, prompt, interval_minutes,
                tool_allow_list, metadata_jsonb, next_run_at,
                next_run_at::text AS next_run_at_token,
                metadata_jsonb #>> '{scheduleExecution,occurrenceId}' AS observed_occurrence_id,
                metadata_jsonb #>> '{scheduleExecution,fence}' AS observed_fence
           FROM clio_scheduled_task
          WHERE enabled = true
            AND (
              next_run_at <= now()
              OR (
                last_status = 'running'
                AND metadata_jsonb #>> '{scheduleExecution,version}' = '1'
                AND NULLIF(metadata_jsonb #>> '{scheduleExecution,occurrenceId}', '') IS NOT NULL
                AND NULLIF(metadata_jsonb #>> '{scheduleExecution,fence}', '') IS NOT NULL
                AND metadata_jsonb #>> '{scheduleExecution,stage}' IN (
                  'claimed', 'research_started', 'result_saved',
                  'email_started', 'email_confirmed', 'email_unknown', 'recovery_unknown'
                )
                AND CASE
                  WHEN pg_input_is_valid(
                    COALESCE(metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}', ''),
                    'timestamptz'
                  )
                  THEN (metadata_jsonb #>> '{scheduleExecution,leaseExpiresAt}')::timestamptz
                         <= clock_timestamp()
                  ELSE false
                END
              )
            )
          ORDER BY next_run_at ASC
          LIMIT ${MAX_TASKS_PER_RUN}`,
      ),
    );

    logger.log(`${due.length} due task(s); dryRun=${dryRun}`);
    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        'CLIO_SCHEDULED_DRYRUN ' +
          JSON.stringify({
            dueCount: due.length,
            tasks: due.map((t) => ({ id: t.id, name: t.name })),
          }),
      );
      return;
    }

    let delivered = 0;
    let failed = 0;
    for (const task of due) {
      const now = options.now?.() ?? new Date();
      const allowList =
        Array.isArray(task.tool_allow_list) && task.tool_allow_list.length
          ? (task.tool_allow_list as string[])
          : [...DEFAULT_SCHEDULED_TOOL_ALLOWLIST];

      const identity = {
        id: task.id,
        tenantId: task.tenant_id,
        ownerUserId: task.owner_user_id,
      };
      const meta =
        task.metadata_jsonb && typeof task.metadata_jsonb === 'object'
          ? (task.metadata_jsonb as Record<string, unknown>)
          : {};
      const runAtMin = typeof meta.runAtMinutesUtc === 'number' ? meta.runAtMinutesUtc : null;
      const nextRunAt = computeNextRunAtAnchored(now, task.interval_minutes, runAtMin);
      const emailTo = typeof meta.emailTo === 'string' ? meta.emailTo : null;

      // The due list is only a snapshot. The claim binds the exact scheduled
      // occurrence, durable lease and fencing token before any provider effect.
      let claimResult;
      try {
        claimResult = await prisma.withTenant(task.tenant_id, (tx: any) =>
          claimScheduledTaskExecution(
            tx,
            identity,
            now,
            nextRunAt,
            task.next_run_at_token,
            emailTo,
            task.observed_occurrence_id && task.observed_fence
              ? {
                  occurrenceId: task.observed_occurrence_id,
                  fence: task.observed_fence,
                }
              : null,
          ),
        );
      } catch (err) {
        logger.warn(`[task ${task.id}] claim acknowledgement uncertain: ${(err as Error).message}`);
        const reconciled = await prisma
          .withTenant(task.tenant_id, (tx: any) =>
            reconcileScheduledTaskClaim(tx, identity, now, task.next_run_at_token),
          )
          .catch(() => null);
        if (!reconciled) {
          failed += 1;
          continue;
        }
        claimResult = { state: 'claimed' as const, claim: reconciled };
      }
      if (claimResult.state === 'inactive') {
        failed += 1;
        continue;
      }
      if (claimResult.state === 'already_running') {
        logger.warn(`[task ${task.id}] active lease retained; another worker owns this occurrence`);
        failed += 1;
        continue;
      }
      if (claimResult.state === 'legacy_running_unknown') {
        logger.warn(
          `[task ${task.id}] legacy running row has no durable lease/receipt; ` +
            'outcome is unknown and automatic replay is forbidden',
        );
        failed += 1;
        continue;
      }
      if (claimResult.state === 'ambiguous_effect') {
        logger.warn(
          `[task ${task.id}] expired ${claimResult.stage} occurrence has an ambiguous effect; ` +
            'it was terminalized without replay',
        );
        failed += 1;
        continue;
      }
      if (claimResult.state === 'notification_unknown') {
        logger.warn(
          `[task ${task.id}] saved result retained but email outcome is unknown; no resend attempted`,
        );
        if (claimResult.result) delivered += 1;
        failed += 1;
        continue;
      }
      const claim: ScheduledTaskExecutionClaim = claimResult.claim;
      await options.checkpoint?.('claimed', { task, claim });
      const finish = (status: string) =>
        prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
          advanceScheduledTaskExecution(tx, identity, claim, status),
        );

      let leaseLost = false;
      let heartbeatBusy = false;
      let heartbeatPromise: Promise<void> | null = null;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || leaseLost) return;
        heartbeatBusy = true;
        heartbeatPromise = prisma
          .withTenant(task.tenant_id, (tx: any) =>
            renewScheduledTaskExecutionLease(tx, identity, claim),
          )
          .then((renewed: boolean) => {
            if (!renewed) leaseLost = true;
          })
          .catch((err: Error) => {
            leaseLost = true;
            logger.warn(`[task ${task.id}] heartbeat failed: ${err.message}`);
          })
          .finally(() => {
            heartbeatBusy = false;
          });
      }, SCHEDULED_TASK_HEARTBEAT_MS);
      heartbeat.unref();

      const authorizeCurrent = async (): Promise<ScheduledTaskAuthorization> => {
        if (leaseLost) return { boundary: 'lease_lost' };
        try {
          return await prisma.withTenant(task.tenant_id, (tx: any) =>
            authorizeScheduledTaskExecution(tx, identity, claim),
          );
        } catch (err) {
          logger.warn(
            `[task ${task.id}] execution boundary check failed; authority is unknown: ` +
              (err as Error).message,
          );
          throw err;
        }
      };
      const finishKnownSuccess = async () => {
        if (await finish('ok')) return true;
        const authorization = await authorizeCurrent();
        if (authorization.boundary === 'authority_denied') {
          return finish('skipped_authority');
        }
        if (authorization.boundary === 'wall_denied') return finish('skipped_wall');
        return false;
      };
      const executeAuthorized: AuthorizedEffect = (effect) =>
        executeAuthorizedScheduledTaskEffect(authorizeCurrent, (authority) =>
          effect(tenantContext(task, authority)),
        );
      // Release E: a run that produced no briefing says so in the owner's
      // inbox; it is never left to read as "no change". Best effort.
      const alertFailure = async (reason: string) => {
        try {
          await prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
            persistScheduledTaskFailureAlert(tx, identity, claim, { taskName: task.name, reason }),
          );
        } catch (err) {
          logger.warn(`[task ${task.id}] failure alert not saved: ${(err as Error).message}`);
        }
      };
      const stopAtBoundary = async (
        boundary: Exclude<ScheduledTaskExecutionBoundary, 'runnable'>,
      ) => {
        if (boundary === 'wall_denied') await finish('skipped_wall');
        if (boundary === 'authority_denied') await finish('skipped_authority');
        failed += 1;
      };

      try {
        if (claimResult.state === 'wall_denied') {
          await stopAtBoundary('wall_denied');
          continue;
        }
        if (claimResult.state === 'authority_denied') {
          await stopAtBoundary('authority_denied');
          continue;
        }
        if (!isAllowListSafe(allowList)) {
          await finish('skipped_unsafe');
          failed += 1;
          continue;
        }

        let saved: ScheduledTaskSavedResult | null = null;
        if (claim.receipt.stage === 'result_saved' || claim.receipt.stage === 'email_confirmed') {
          saved = await prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
            readScheduledTaskSavedResult(tx, identity, claim),
          );
          if (!saved) {
            logger.warn(`[task ${task.id}] durable result reference has no current exact alert`);
            await finish('recovery_unknown');
            failed += 1;
            continue;
          }
          delivered += 1;
        } else {
          const started = await prisma.withTenant(task.tenant_id, (tx: any) =>
            markScheduledTaskResearchStarted(tx, identity, claim),
          );
          if (!started) {
            const authorization = await authorizeCurrent();
            await stopAtBoundary(
              authorization.boundary === 'runnable' ? 'lease_lost' : authorization.boundary,
            );
            continue;
          }

          let credentialEffect;
          try {
            credentialEffect = await executeAuthorized<ResolvedAiCredential | null>((currentCtx) =>
              aiCreds.resolveProvider(currentCtx, 'anthropic'),
            );
          } catch (err) {
            logger.warn(
              `[task ${task.id}] credential resolution failed: ${(err as Error).message}`,
            );
            await alertFailure('the model credential could not be loaded');
            await finish('error');
            failed += 1;
            continue;
          }
          if (!credentialEffect.executed) {
            await stopAtBoundary(credentialEffect.boundary);
            continue;
          }
          const resolved = credentialEffect.value;
          if (!resolved?.apiKey) {
            logger.warn(`[task ${task.id}] no Anthropic credential; skipping`);
            await alertFailure('no model credential is configured');
            await finish('error');
            failed += 1;
            continue;
          }

          let result: ScheduledResearchResult = null;
          try {
            result = options.research
              ? await options.research({ task, executeAuthorized })
              : await runResearch(
                  task,
                  toolsService,
                  resolved.apiKey,
                  resolved.model,
                  resolved.usedTenantKey,
                  allowList,
                  logger,
                  prisma,
                  executeAuthorized,
                );
          } catch (err) {
            logger.warn(`[task ${task.id}] research failed: ${(err as Error).message}`);
          }
          if (isBlockedResearchResult(result)) {
            await stopAtBoundary(result.blocked);
            continue;
          }
          if (!result || !result.text) {
            await alertFailure('the model returned no briefing');
            await finish('error');
            failed += 1;
            continue;
          }

          try {
            await prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
              persistScheduledTaskResultAndAlert(tx, identity, claim, {
                taskName: task.name,
                // A briefing cut short says so at the top (Release E).
                text: result.stopped
                  ? `${scheduledRunStopNote(result.stopped)}\n\n${result.text}`
                  : result.text,
                toolsUsed: result.toolsUsed,
              }),
            );
          } catch (err) {
            // A transaction acknowledgement can be lost after both the alert and
            // result reference committed. Fresh-read before deciding it failed.
            saved = await prisma
              .withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
                readScheduledTaskSavedResult(tx, identity, claim),
              )
              .catch(() => null);
            if (!saved) throw err;
          }
          saved ??= await prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
            readScheduledTaskSavedResult(tx, identity, claim),
          );
          if (!saved) throw new Error('saved result was not readable after commit');
          delivered += 1;
        }

        await options.checkpoint?.('result_saved', { task, claim });

        if (claim.receipt.stage === 'email_confirmed') {
          await finishKnownSuccess();
          continue;
        }
        if (!emailTo) {
          await finishKnownSuccess();
          continue;
        }

        try {
          const began = await prisma.withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
            beginScheduledTaskEmailDispatch(tx, identity, claim),
          );
          if (!began) {
            await stopAtBoundary('lease_lost');
            continue;
          }
        } catch (err) {
          // If COMMIT may have happened, dispatch-started is already unknown.
          // Never issue the external call after this ambiguity.
          logger.warn(
            `[task ${task.id}] email dispatch-start acknowledgement uncertain; no send attempted: ` +
              (err as Error).message,
          );
          await finish('notification_unknown');
          failed += 1;
          continue;
        }

        const email = await executeAuthorized<{
          ok: boolean;
          sentFrom?: string;
          error?: string;
        }>((currentCtx) =>
          toolsService.sendScheduledBriefingEmail(
            currentCtx,
            emailTo,
            `Meri briefing: ${task.name}`,
            saved!.text,
          ),
        );
        if (email.executed === false) {
          await stopAtBoundary(email.boundary);
          continue;
        }
        const sent = email.value;
        await options.checkpoint?.('email_effect', { task, claim });
        const confirmed = sent.ok === true;
        const outcomeWritten = await prisma
          .withTenantUser(task.tenant_id, task.owner_user_id, (tx: any) =>
            recordScheduledTaskEmailOutcome(
              tx,
              identity,
              claim,
              confirmed
                ? { confirmed: true, sentFrom: sent.sentFrom }
                : { confirmed: false, error: sent.error },
            ),
          )
          .catch((err: Error) => {
            logger.warn(`[task ${task.id}] email outcome receipt failed: ${err.message}`);
            return false;
          });
        if (confirmed && outcomeWritten) {
          logger.log(`[task ${task.id}] briefing email confirmed for ${emailTo}`);
          await finishKnownSuccess();
        } else {
          logger.warn(
            `[task ${task.id}] briefing result is saved; email outcome is unknown and will not be retried`,
          );
          await finish('notification_unknown');
          failed += 1;
        }
      } catch (err) {
        logger.warn(`[task ${task.id}] delivery/recovery failed: ${(err as Error).message}`);
        await finish('error');
        failed += 1;
      } finally {
        clearInterval(heartbeat);
        await heartbeatPromise;
      }
    }

    logger.log(
      `done: due=${due.length} delivered=${delivered} failed=${failed} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    // eslint-disable-next-line no-console
    console.log('CLIO_SCHEDULED_REPORT ' + JSON.stringify({ due: due.length, delivered, failed }));
  } finally {
    await app?.close();
  }
}

if (require.main === module) {
  void runScheduledTasks().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[run-meri-scheduled-tasks] FAILED', err);
    process.exit(1);
  });
}
