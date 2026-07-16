/**
 * Compute engagement health scores for all active clients across all tenants.
 * Stores results as IntelligenceInsight with category='health_score'.
 * Emits IntelligenceChange when score drops below 30 (severity='notable', changeType='low_engagement').
 *   npx tsx scripts/compute-health-scores.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

interface HealthCounts {
  meetings: number;
  emails: number;
  tasksCompleted: number;
  debriefs: number;
  outreachSent: number;
}

async function countForPeriod(
  tenantId: string,
  clientId: string,
  from: Date,
  to: Date,
): Promise<HealthCounts> {
  const [m, e, t, d, o] = await Promise.all([
    prisma.$queryRaw<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM meetings
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND starts_at >= ${from} AND starts_at < ${to}
    `,
    prisma.$queryRaw<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM mail_threads
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND last_message_at >= ${from} AND last_message_at < ${to}
    `,
    prisma.$queryRaw<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM engagement_tasks
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND status = 'done' AND updated_at >= ${from} AND updated_at < ${to}
    `,
    prisma.$queryRaw<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM meeting_debriefs
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND created_at >= ${from} AND created_at < ${to}
    `,
    prisma.$queryRaw<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM outreach_records
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND sent_at >= ${from} AND sent_at < ${to}
    `,
  ]);

  return {
    meetings: parseInt(m[0]?.n ?? '0', 10),
    emails: parseInt(e[0]?.n ?? '0', 10),
    tasksCompleted: parseInt(t[0]?.n ?? '0', 10),
    debriefs: parseInt(d[0]?.n ?? '0', 10),
    outreachSent: parseInt(o[0]?.n ?? '0', 10),
  };
}

function computeScore(counts: HealthCounts): number {
  const expectedWeeklyPace = 100;
  return Math.min(
    100,
    Math.round(
      ((counts.meetings * 15 +
        counts.emails * 2 +
        counts.tasksCompleted * 10 +
        counts.debriefs * 20 +
        counts.outreachSent * 5) /
        expectedWeeklyPace) *
        100,
    ),
  );
}

async function main() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const startedAt = now;

  console.log(`[compute-health-scores] starting at ${startedAt.toISOString()}`);

  await runWithSyncRun(prisma as any, 'compute-health-scores', async () => {
    const tenants = await prisma.$queryRaw<Array<{ id: string; slug: string }>>`
    SELECT id, slug FROM tenants WHERE status = 'active'
  `;

    let computed = 0;
    let lowEngagementEmitted = 0;
    let errors = 0;

    for (const tenant of tenants) {
      const clients = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM clients
      WHERE tenant_id = ${tenant.id}::uuid AND profile_status = 'ACTIVE'
    `;

      console.log(`[compute-health-scores] tenant=${tenant.slug}, ${clients.length} clients`);

      for (const client of clients) {
        try {
          const [current, prior] = await Promise.all([
            countForPeriod(tenant.id, client.id, sevenDaysAgo, now),
            countForPeriod(tenant.id, client.id, fourteenDaysAgo, sevenDaysAgo),
          ]);

          const score = computeScore(current);
          const priorScore = computeScore(prior);
          const trend: 'improving' | 'stable' | 'declining' =
            score > priorScore + 5 ? 'improving' : score < priorScore - 5 ? 'declining' : 'stable';

          const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          await prisma.intelligenceInsight.create({
            data: {
              // GAI-01: tenant/client-scope the row (this data is tenant-derived —
              // it must never sit in a globally-readable feed). Runs as
              // capiro_master which bypasses FORCE RLS on write; the columns are
              // what the serve-path RLS read filters on.
              tenantId: tenant.id,
              clientId: client.id,
              category: 'health_score',
              title: `Engagement health: ${client.name}`,
              body: `Score ${score}/100 (${trend}) for the past 7 days. Meetings: ${current.meetings}, Emails: ${current.emails}, Tasks completed: ${current.tasksCompleted}, Debriefs: ${current.debriefs}, Outreach sent: ${current.outreachSent}.`,
              severity: score < 30 ? 'notable' : score < 60 ? 'info' : 'info',
              dataPoints: {
                score,
                priorScore,
                trend,
                breakdown: current,
                period: '7d',
                clientId: client.id,
                tenantId: tenant.id,
              },
              expiresAt,
            },
          });

          // Emit low-engagement alert when score drops below 30
          if (score < 30) {
            await prisma.intelligenceChange.create({
              data: {
                source: 'engagement_health',
                changeType: 'low_engagement',
                severity: 'notable',
                title: `Low engagement score for ${client.name}: ${score}/100`,
                description: `Engagement health score dropped to ${score}/100 (${trend} vs prior week). Meetings: ${current.meetings}, Emails: ${current.emails}, Tasks completed: ${current.tasksCompleted}.`,
                relatedClientIds: [client.id],
                relatedIssues: [],
                data: { score, priorScore, trend, breakdown: current },
              },
            });
            lowEngagementEmitted++;
          }

          computed++;
        } catch (err) {
          errors++;
          console.error(`[compute-health-scores] ${client.name}, error:`, err);
        }
      }
    }

    console.log(
      `[compute-health-scores] done. Computed ${computed} scores, ${lowEngagementEmitted} low-engagement alerts, ${errors} errors. Elapsed: ${Date.now() - startedAt.getTime()}ms`,
    );
    return { inserted: 0, updated: computed, skipped: 0, errors };
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
