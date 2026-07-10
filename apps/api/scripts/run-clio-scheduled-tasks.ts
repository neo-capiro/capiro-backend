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
import {
  computeNextRunAtAnchored,
  isAllowListSafe,
  DEFAULT_SCHEDULED_TOOL_ALLOWLIST,
} from '../src/meri/meri-schedule.helpers.js';

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
  ctx: TenantContext,
  toolsService: any,
  apiKey: string,
  model: string,
  usedTenantKey: boolean,
  allowList: string[],
  logger: Logger,
  prisma: any,
): Promise<{ text: string; toolsUsed: string[] } | null> {
  // Filter the full Meri tool schema list to the task's allow-list, and harden:
  // never attach a tool that isn't read-only-safe (defense in depth on top of
  // isAllowListSafe, which we also check before calling this).
  const allowSet = new Set(allowList);
  const allSchemas: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> =
    toolsService.anthropicToolSchemas();
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
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: toolSchemas,
          messages,
        }),
      });
      if (!res.ok) {
        logger.warn(`[task ${task.id}] anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return lastText ? { text: lastText, toolsUsed } : null;
      }
      json = await res.json();
    } catch (err) {
      logger.warn(`[task ${task.id}] anthropic call failed: ${(err as Error).message}`);
      return lastText ? { text: lastText, toolsUsed } : null;
    }

    // Phase 1 M5.0 (H-1): meter this round — one ai_usage_events row per
    // Anthropic call, same as the interactive chat/in-editor loops.
    await recordAiUsageEvent(
      { prisma, logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'clio_scheduled_task',
      { provider: 'anthropic', model, usage: parseProviderUsage(json), usedTenantKey },
    );

    const content: Array<any> = Array.isArray(json.content) ? json.content : [];
    const textBlocks = content.filter((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length) lastText = textBlocks.map((b) => b.text).join('\n').trim();

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
      const input = (tu.input && typeof tu.input === 'object') ? tu.input : {};
      // Default clientId from the task metadata if the model omitted it.
      const meta = (task.metadata_jsonb && typeof task.metadata_jsonb === 'object')
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
          payload = await toolsService.execute(ctx, name, input);
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
  // summary in the last text block before requesting more tools).
  return lastText ? { text: lastText, toolsUsed } : null;
}

async function main(): Promise<void> {
  const logger = new Logger('run-meri-scheduled-tasks');
  const { AppModule, PrismaService, MeriToolsService, AiCredentialResolverService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const t0 = Date.now();
  try {
    const prisma = app.get(PrismaService);
    const toolsService = app.get(MeriToolsService);
    const aiCreds = app.get(AiCredentialResolverService);

    const due: DueTask[] = await prisma.withSystem((tx: any) =>
      tx.$queryRawUnsafe(
        `SELECT id, tenant_id, owner_user_id, name, prompt, interval_minutes, tool_allow_list, metadata_jsonb
         FROM clio_scheduled_task
         WHERE enabled = true AND next_run_at <= now()
         ORDER BY next_run_at ASC
         LIMIT ${MAX_TASKS_PER_RUN}`,
      ),
    );

    logger.log(`${due.length} due task(s); dryRun=${DRY_RUN}`);
    if (DRY_RUN) {
      // eslint-disable-next-line no-console
      console.log(
        'CLIO_SCHEDULED_DRYRUN ' +
          JSON.stringify({ dueCount: due.length, tasks: due.map((t) => ({ id: t.id, name: t.name })) }),
      );
      return;
    }

    let delivered = 0;
    let failed = 0;
    for (const task of due) {
      const now = new Date();
      const allowList = Array.isArray(task.tool_allow_list) && task.tool_allow_list.length
        ? (task.tool_allow_list as string[])
        : [...DEFAULT_SCHEDULED_TOOL_ALLOWLIST];
      if (!isAllowListSafe(allowList)) {
        await advance(prisma, task, now, 'skipped_unsafe');
        failed += 1;
        continue;
      }

      // Resolve the owner's role for the tenant context (default to 'member').
      let role = 'member';
      let clerkUserId = '';
      let tenantSlug = '';
      try {
        const info: any[] = await prisma.withSystem((tx: any) =>
          tx.$queryRawUnsafe(
            `SELECT tm.role AS role, u.clerk_user_id AS clerk, t.slug AS slug
             FROM tenant_memberships tm
             JOIN tenants t ON t.id = tm.tenant_id
             LEFT JOIN users u ON u.id = tm.user_id
             WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid
             LIMIT 1`,
            task.tenant_id,
            task.owner_user_id,
          ),
        );
        if (info.length) {
          role = info[0].role ?? 'member';
          clerkUserId = info[0].clerk ?? '';
          tenantSlug = info[0].slug ?? '';
        }
      } catch { /* fall back to defaults */ }

      const ctx: TenantContext = {
        tenantId: task.tenant_id,
        tenantSlug,
        userId: task.owner_user_id,
        clerkUserId,
        role: role as TenantContext['role'],
      };

      // Resolve the tenant's Anthropic key + model (tenant key first, then global).
      const resolved = await aiCreds.resolveProvider(ctx, 'anthropic');
      if (!resolved?.apiKey) {
        logger.warn(`[task ${task.id}] no Anthropic credential; skipping`);
        await advance(prisma, task, now, 'error');
        failed += 1;
        continue;
      }

      let result: { text: string; toolsUsed: string[] } | null = null;
      try {
        result = await runResearch(
          task,
          ctx,
          toolsService,
          resolved.apiKey,
          resolved.model,
          resolved.usedTenantKey,
          allowList,
          logger,
          prisma,
        );
      } catch (err) {
        logger.warn(`[task ${task.id}] research failed: ${(err as Error).message}`);
      }

      if (!result || !result.text) {
        await advance(prisma, task, now, 'error');
        failed += 1;
        continue;
      }

      try {
        await prisma.withTenant(task.tenant_id, (tx: any) =>
          tx.clioProactiveAlert.create({
            data: {
              tenantId: task.tenant_id,
              alertType: 'scheduled_task',
              title: `Scheduled: ${task.name}`,
              body: result!.text.slice(0, 8000),
              priority: 'normal',
              sourceType: 'scheduled_task',
              sourceId: `${task.id}:${now.toISOString().slice(0, 10)}`,
              metadata: {
                taskId: task.id,
                ownerUserId: task.owner_user_id,
                runAt: now.toISOString(),
                toolsUsed: result!.toolsUsed,
              },
            },
          }),
        );
        await advance(prisma, task, now, 'ok');
        delivered += 1;

        // Optional fixed email delivery: if the task was created with a frozen
        // recipient (metadata.emailTo), also email the finished briefing there.
        // The recipient was authorized at creation time; the model never chose
        // it and never had a send tool. Email failure is non-fatal — the inbox
        // delivery already succeeded.
        const meta = (task.metadata_jsonb && typeof task.metadata_jsonb === 'object')
          ? (task.metadata_jsonb as Record<string, unknown>)
          : {};
        const emailTo = typeof meta.emailTo === 'string' ? meta.emailTo : null;
        if (emailTo) {
          const sent = await toolsService.sendScheduledBriefingEmail(
            ctx,
            emailTo,
            `Meri briefing: ${task.name}`,
            result!.text,
          );
          if (sent.ok) {
            logger.log(`[task ${task.id}] briefing emailed to ${emailTo} from ${sent.sentFrom}`);
          } else {
            logger.warn(`[task ${task.id}] briefing email to ${emailTo} failed: ${sent.error}`);
          }
        }
      } catch (err) {
        logger.warn(`[task ${task.id}] deliver failed: ${(err as Error).message}`);
        await advance(prisma, task, now, 'error');
        failed += 1;
      }
    }

    logger.log(
      `done: due=${due.length} delivered=${delivered} failed=${failed} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    // eslint-disable-next-line no-console
    console.log('CLIO_SCHEDULED_REPORT ' + JSON.stringify({ due: due.length, delivered, failed }));
  } finally {
    await app.close();
  }
}

/** Advance next_run_at (clock-anchored when metadata.runAtMinutesUtc is set). */
async function advance(prisma: any, task: DueTask, now: Date, status: string): Promise<void> {
  const meta = (task.metadata_jsonb && typeof task.metadata_jsonb === 'object')
    ? (task.metadata_jsonb as Record<string, unknown>)
    : {};
  const runAtMin = typeof meta.runAtMinutesUtc === 'number' ? meta.runAtMinutesUtc : null;
  const next = computeNextRunAtAnchored(now, task.interval_minutes, runAtMin);
  await prisma.withSystem((tx: any) =>
    tx.$executeRawUnsafe(
      `UPDATE clio_scheduled_task
       SET last_run_at = $1, next_run_at = $2, last_status = $3, run_count = run_count + 1, updated_at = now()
       WHERE id = $4::uuid`,
      now,
      next,
      status,
      task.id,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[run-meri-scheduled-tasks] FAILED', err);
  process.exit(1);
});
