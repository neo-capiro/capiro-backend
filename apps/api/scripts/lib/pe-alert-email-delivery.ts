import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { runWithSyncRun, type RunCounts } from '../../src/ingestion/sync-run.helper.js';
import {
  sesEmailAcceptance,
  sesEmailFailure,
  type EmailSendResult,
} from '../../src/tracker/notifications/tracker-email.service.js';

const SOURCE = 'send-pe-alert-emails';
const POLICY = 'best_effort_non_retry';
export interface PeEmailWindow {
  runId?: string;
  since: Date;
  until: Date;
}

export function peEmailWindowStats(window: PeEmailWindow) {
  return {
    deliveryPolicy: POLICY,
    windowConsumed: true,
    windowStart: window.since.toISOString(),
    windowEnd: window.until.toISOString(),
  };
}

/** A consumed SyncRun window is excluded even after error, receipt-write failure or crash. */
export async function peEmailWindow(
  tx: Prisma.TransactionClient,
  until: Date,
  hours: number,
  runId?: string,
): Promise<PeEmailWindow> {
  if (runId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SOURCE}))`;
  const where = { source: SOURCE, ...(runId ? { id: { not: runId } } : {}) };
  const consumed = await tx.syncRun.findFirst({
    where: {
      ...where,
      AND: [
        { stats: { path: ['deliveryPolicy'], equals: POLICY } },
        { stats: { path: ['windowConsumed'], equals: true } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  // Older runs read an unbounded tail and have no provable consumed boundary.
  // The first upgraded run fences that historical interval instead of replaying it.
  const legacy =
    !consumed &&
    (
      await tx.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM sync_run WHERE source = ${SOURCE}
      AND (${runId ?? null}::uuid IS NULL OR id <> ${runId ?? null}::uuid)
      AND COALESCE(stats_jsonb->>'deliveryPolicy', '') <> ${POLICY}) AS present
  `
    )[0]!.present;
  const floor = consumed
    ? Math.max(consumed.startedAt.getTime(), until.getTime() - 48 * 3600_000)
    : legacy
      ? until.getTime()
      : until.getTime() - hours * 3600_000;
  const window = { runId, until, since: new Date(Math.min(floor, until.getTime())) };
  if (runId)
    await tx.syncRun.update({
      where: { id: runId },
      data: { stats: { ...peEmailWindowStats(window), outcome: 'outcome_unknown' } },
    });
  return window;
}

/** Capture the existing helper's row; its callback otherwise exposes no run id. No second ledger. */
export async function runPeEmailWindow(
  prisma: PrismaService,
  hours: number,
  run: (window: PeEmailWindow) => Promise<RunCounts>,
): Promise<RunCounts> {
  let current: { id: string; startedAt: Date } | undefined;
  return runWithSyncRun(
    {
      syncRun: {
        findFirst: (args) => prisma.syncRun.findFirst(args as Prisma.SyncRunFindFirstArgs),
        create: async (args) => {
          current = await prisma.syncRun.create({
            ...(args as Prisma.SyncRunCreateArgs),
            data: {
              ...(args as Prisma.SyncRunCreateArgs).data,
              stats: { deliveryPolicy: POLICY, windowConsumed: false },
            },
            select: { id: true, startedAt: true },
          });
          return current;
        },
        update: (args) => prisma.syncRun.update(args as Prisma.SyncRunUpdateArgs),
      },
    },
    SOURCE,
    async () => {
      if (!current) throw new Error('PE email run was not recorded');
      const { id, startedAt } = current;
      const window = await prisma.withSystem((tx) => peEmailWindow(tx, startedAt, hours, id));
      const result = await run(window);
      return { ...result, stats: { ...result.stats, ...peEmailWindowStats(window) } };
    },
  );
}

export interface PeQueuedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** One SES attempt per recipient; persist uncertainty before I/O and each observed result. */
export async function sendPeEmailBatch(
  emails: PeQueuedEmail[],
  from: string,
  region: string,
  record: (outcomes: EmailSendResult[]) => Promise<void>,
): Promise<EmailSendResult[]> {
  const outcomes: EmailSendResult[] = emails.map(() => ({ status: 'outcome_unknown' }));
  await record(outcomes);
  const ses = new SESv2Client({ region, maxAttempts: 1 });
  try {
    for (const [index, email] of emails.entries()) {
      try {
        const response = await ses.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [email.to] },
            Content: {
              Simple: {
                Subject: { Data: email.subject, Charset: 'UTF-8' },
                Body: {
                  Html: { Data: email.html, Charset: 'UTF-8' },
                  Text: { Data: email.text, Charset: 'UTF-8' },
                },
              },
            },
          }),
        );
        outcomes[index] = sesEmailAcceptance(response.MessageId);
      } catch (cause) {
        outcomes[index] = sesEmailFailure(cause);
      }
      // Receipt persistence is outside the provider catch. Its failure halts
      // further sends; the already-consumed window is never automatically replayed.
      await record(outcomes);
    }
    return outcomes;
  } finally {
    ses.destroy();
  }
}
