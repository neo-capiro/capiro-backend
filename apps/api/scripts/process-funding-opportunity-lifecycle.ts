/**
 * Expire machine suggestions and emit deterministic internal alerts for saved or
 * pursuing funding opportunities. Dry-run by default; --commit writes.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';

dotenvConfig();

const SOURCE = 'process-funding-opportunity-lifecycle';
const ROW_CAP = 5000;
const CLOSING_SOON_DAYS = 14;

export type LifecycleEventType =
  | 'deadline_changed'
  | 'amended'
  | 'cancelled_or_closed'
  | 'closing_soon';

export interface LifecycleSnapshot {
  status: string | null;
  deadline: Date | null;
  updatedAt: Date | null;
  active: boolean;
}

export interface LifecycleEvent {
  type: LifecycleEventType;
  title: string;
  body: string;
  fingerprint: string;
}

function iso(value: Date | null): string {
  return value?.toISOString() ?? 'none';
}

export function deriveLifecycleEvents(input: {
  title: string;
  workflowStatus: string;
  previous: LifecycleSnapshot;
  current: LifecycleSnapshot;
  now: Date;
}): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const { title, workflowStatus, previous, current, now } = input;
  const humanTracked = workflowStatus === 'saved' || workflowStatus === 'pursuing';

  if (previous.deadline && current.deadline && previous.deadline.getTime() !== current.deadline.getTime()) {
    events.push({
      type: 'deadline_changed',
      title: `Deadline changed: ${title}`,
      body: `The response deadline changed from ${previous.deadline.toISOString()} to ${current.deadline.toISOString()}.`,
      fingerprint: `${iso(previous.deadline)}:${iso(current.deadline)}`,
    });
  }
  if (
    previous.updatedAt &&
    current.updatedAt &&
    current.updatedAt.getTime() > previous.updatedAt.getTime()
  ) {
    events.push({
      type: 'amended',
      title: `Opportunity updated: ${title}`,
      body: 'The source record has been updated since Capiro last evaluated this opportunity. Review the source notice for amendments.',
      fingerprint: iso(current.updatedAt),
    });
  }
  if (previous.active && !current.active) {
    events.push({
      type: 'cancelled_or_closed',
      title: `Opportunity closed: ${title}`,
      body: `The source now reports this opportunity as ${current.status ?? 'closed or inactive'}.`,
      fingerprint: `${current.status ?? 'inactive'}:${iso(current.deadline)}`,
    });
  }
  if (humanTracked && current.active && current.deadline) {
    const remaining = current.deadline.getTime() - now.getTime();
    const max = CLOSING_SOON_DAYS * 86_400_000;
    if (remaining >= 0 && remaining <= max) {
      const days = Math.ceil(remaining / 86_400_000);
      events.push({
        type: 'closing_soon',
        title: `Closing soon: ${title}`,
        body: `${days} day${days === 1 ? '' : 's'} remain before the response deadline.`,
        fingerprint: current.deadline.toISOString().slice(0, 10),
      });
    }
  }
  return events;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

async function tenantIds(prisma: PrismaClient, explicit: string | null): Promise<string[]> {
  if (explicit) return [explicit];
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id FROM intel_feature_flag
      WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
    `,
  );
  return [...new Set(rows.map((row) => row.tenant_id))];
}

function grantActive(status: string | null, deadline: Date | null, now: Date): boolean {
  return ['posted', 'forecasted'].includes((status ?? '').toLowerCase()) &&
    (deadline == null || deadline.getTime() >= now.getTime());
}
function samActive(active: boolean, deadline: Date | null, archiveDate: Date | null, now: Date): boolean {
  return active &&
    (deadline == null || deadline.getTime() >= now.getTime()) &&
    (archiveDate == null || archiveDate.getTime() >= now.getTime());
}

export async function processLifecycle(
  prisma: PrismaClient,
  options: { tenantIds: string[]; commit: boolean; now?: Date },
): Promise<RunCounts & { evaluated: number; alerts: number; expired: number; capped: boolean }> {
  const counts = emptyCounts();
  const now = options.now ?? new Date();
  let evaluated = 0;
  let alerts = 0;
  let expired = 0;
  let capped = false;

  for (const tenantId of options.tenantIds) {
    const rows = await withBypass(prisma, (tx) =>
      tx.clientFundingOpportunity.findMany({
        where: { tenantId },
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          source: true,
          grantOpportunityId: true,
          samOpportunityId: true,
          workflowStatus: true,
          userCreated: true,
          sourceStatusSnapshot: true,
          responseDeadlineSnapshot: true,
          sourceUpdatedAtSnapshot: true,
        },
        orderBy: { id: 'asc' },
        take: ROW_CAP,
      }),
    );
    if (rows.length >= ROW_CAP) capped = true;

    const grantIds = rows.flatMap((row) => (row.grantOpportunityId ? [row.grantOpportunityId] : []));
    const samIds = rows.flatMap((row) => (row.samOpportunityId ? [row.samOpportunityId] : []));
    const [grants, sam] = await Promise.all([
      grantIds.length
        ? prisma.federalGrant.findMany({
            where: { id: { in: grantIds } },
            select: {
              id: true,
              title: true,
              status: true,
              closeDate: true,
              lastUpdatedAt: true,
              detailSyncedAt: true,
              syncedAt: true,
            },
          })
        : [],
      samIds.length
        ? prisma.samOpportunity.findMany({
            where: { id: { in: samIds } },
            select: {
              id: true,
              title: true,
              active: true,
              responseDeadline: true,
              archiveDate: true,
              updatedAt: true,
              lastSyncedAt: true,
            },
          })
        : [],
    ]);
    const grantById = new Map(grants.map((row) => [row.id, row]));
    const samById = new Map(sam.map((row) => [row.id, row]));

    for (const row of rows) {
      evaluated += 1;
      try {
        const grant = row.grantOpportunityId ? grantById.get(row.grantOpportunityId) : null;
        const contract = row.samOpportunityId ? samById.get(row.samOpportunityId) : null;
        if (!grant && !contract) {
          counts.errors += 1;
          continue;
        }
        const title = grant?.title ?? contract!.title;
        const current: LifecycleSnapshot = grant
          ? {
              status: grant.status,
              deadline: grant.closeDate,
              updatedAt: grant.lastUpdatedAt ?? grant.detailSyncedAt ?? grant.syncedAt,
              active: grantActive(grant.status, grant.closeDate, now),
            }
          : {
              status: contract!.active ? 'active' : 'archived',
              deadline: contract!.responseDeadline,
              updatedAt: contract!.updatedAt ?? contract!.lastSyncedAt,
              active: samActive(
                contract!.active,
                contract!.responseDeadline,
                contract!.archiveDate,
                now,
              ),
            };
        const previous: LifecycleSnapshot = {
          status: row.sourceStatusSnapshot,
          deadline: row.responseDeadlineSnapshot,
          updatedAt: row.sourceUpdatedAtSnapshot,
          active: !['closed', 'archived', 'inactive', 'cancelled'].includes(
            (row.sourceStatusSnapshot ?? '').toLowerCase(),
          ),
        };
        const events = deriveLifecycleEvents({
          title,
          workflowStatus: row.workflowStatus,
          previous,
          current,
          now,
        });
        const shouldExpire =
          !current.active && row.workflowStatus === 'suggested' && row.userCreated === false;

        if (options.commit) {
          await withBypass(prisma, async (tx) => {
            for (const event of events) {
              const sourceId = `${row.id}:${event.type}:${event.fingerprint}`;
              const exists = await tx.clioProactiveAlert.findFirst({
                where: { tenantId, sourceType: 'funding_opportunity', sourceId },
                select: { id: true },
              });
              if (!exists) {
                await tx.clioProactiveAlert.create({
                  data: {
                    tenantId,
                    clientId: row.clientId,
                    alertType: 'funding_opportunity',
                    title: event.title,
                    body: event.body,
                    priority: event.type === 'closing_soon' ? 'high' : 'normal',
                    sourceType: 'funding_opportunity',
                    sourceId,
                    metadata: {
                      workflowId: row.id,
                      source: row.source,
                      eventType: event.type,
                    } as Prisma.InputJsonValue,
                  },
                });
                alerts += 1;
              }
            }
            await tx.clientFundingOpportunity.update({
              where: { id: row.id },
              data: {
                ...(shouldExpire ? { workflowStatus: 'expired' } : {}),
                sourceStatusSnapshot: current.status,
                responseDeadlineSnapshot: current.deadline,
                sourceUpdatedAtSnapshot: current.updatedAt,
              },
            });
          });
        } else {
          alerts += events.length;
        }
        if (shouldExpire) expired += 1;
        counts.updated += 1;
      } catch (error) {
        counts.errors += 1;
        console.warn(`[${SOURCE}] failed workflow ${row.id}: ${(error as Error).message}`);
      }
    }
  }
  if (capped) counts.errors += 1;
  return { ...counts, evaluated, alerts, expired, capped };
}

async function main(): Promise<void> {
  const commit = flag(process.argv, 'commit');
  const explicitTenant = value(process.argv, 'tenant');
  const prisma = new PrismaClient();
  try {
    const ids = await tenantIds(prisma, explicitTenant);
    // Report inside the closure: evaluated/alerts/expired/capped belong to this
    // script's result type, not to the bare RunCounts that runWithSyncRun
    // resolves to, and on the skipIfRunning path the helper never runs this
    // body at all. See generate-funding-grant-candidates.ts for the same shape.
    const execute = async (): Promise<RunCounts> => {
      const result = await processLifecycle(prisma, { tenantIds: ids, commit });
      console.log(
        `[${SOURCE}] ${commit ? 'COMMITTED' : 'DRY RUN'} tenants=${ids.length} evaluated=${result.evaluated} ` +
          `alerts=${result.alerts} expired=${result.expired} errors=${result.errors}`,
      );
      if (result.capped) console.warn(`[${SOURCE}] ⚠️ CAPPED: lifecycle coverage is partial.`);
      return result;
    };
    if (commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute);
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /process-funding-opportunity-lifecycle(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
