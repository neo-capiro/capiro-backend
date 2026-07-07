/**
 * send-pe-alert-emails — PE Watch daily alert emails + client-watchlist
 * stamping (PE Watch auto-update plan, Phase 2).
 *
 *   send-pe-alert-emails             # DRY RUN: print who would get what
 *   send-pe-alert-emails --commit    # stamp client relevance + send emails
 *   flags: --hours N (window floor when no watermark; default 25)
 *
 * What it does, per run:
 *   1. Collect IntelligenceChange rows in the send window that carry
 *      relatedPeCodes (writer-emitted pe_* types, budget_doc_watch rows with a
 *      PE, pe_hearing_mention candidates, …).
 *   2. Unified watchlists: match each alerted PE's title + accepted capability
 *      terms against every tenant's ClientWatchlist tags (whole-word) and add
 *      the matching client ids to the alert's relatedClientIds — one client
 *      watchlist now powers PE alerts too.
 *   3. Per user with >=1 program_element_watch: build their digest (their
 *      watched PEs ∩ window alerts) and email it via SESv2. Preference comes
 *      from pe_alert_email_pref (mode off | daily | daily_plus_critical; no
 *      row = daily). Both non-off modes send in this nightly run — the
 *      distinction exists for a future intraday critical path.
 *
 * CANARY GATE: PE_ALERT_EMAIL_TENANTS env — comma-separated tenant UUIDs or
 * 'all'. Unset/empty = fully dark (no emails, watchlist stamping still runs).
 * Flip the canary by setting it to the capiro-internal tenant id.
 *
 * Send watermark: commit runs wrap in runWithSyncRun('send-pe-alert-emails');
 * the window starts at the last successful run (capped at 48h back) so a
 * same-day re-run cannot double-email earlier alerts.
 */
import { config as dotenvConfig } from 'dotenv';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  digestForUser,
  matchWatchlistClients,
  parseWatchlistTags,
  renderPeDigestEmail,
  type PeAlertItem,
} from '../src/program-element/pe-alerts/pe-alert-email.js';
import {
  lastSuccessfulWatermark,
  runWithSyncRun,
  type RunCounts,
} from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const SYNC_SOURCE = 'send-pe-alert-emails';
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argVal = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function canaryTenants(): { all: boolean; ids: Set<string> } {
  const raw = (process.env.PE_ALERT_EMAIL_TENANTS ?? '').trim();
  if (raw.toLowerCase() === 'all') return { all: true, ids: new Set() };
  return {
    all: false,
    ids: new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const hours = Number(argVal('hours') ?? 25);
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const appBaseUrl = process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai';
  const from = process.env.TRACKER_ALERT_EMAIL_FROM ?? 'alerts@capiro.ai';
  const region = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

  /** One rendered email queued to send AFTER the DB transaction commits. */
  interface QueuedEmail {
    to: string;
    tenantId: string;
    subject: string;
    html: string;
    text: string;
    total: number;
    critical: number;
  }

  const run = async (): Promise<RunCounts> => {
    const canary = canaryTenants();
    const watermark = await lastSuccessfulWatermark(prisma, SYNC_SOURCE);
    const floor = new Date(Date.now() - hours * 3600 * 1000);
    const cap = new Date(Date.now() - 48 * 3600 * 1000);
    const since = watermark
      ? new Date(Math.max(watermark.getTime(), cap.getTime()))
      : floor;

    // Phase A — all DB reads + watchlist stamping inside one bypass-RLS
    // transaction; build the email plan but send NOTHING here. Sending is
    // external network I/O and must not hold a Postgres transaction open
    // (connection-pool + long-transaction hazard at scale).
    const { summary, queued } = await prisma.withSystem(async (tx) => {
      const rawAlerts = await tx.intelligenceChange.findMany({
        where: { detectedAt: { gte: since }, relatedPeCodes: { isEmpty: false } },
        select: {
          id: true,
          changeType: true,
          severity: true,
          title: true,
          description: true,
          relatedPeCodes: true,
          relatedClientIds: true,
          detectedAt: true,
        },
        orderBy: { detectedAt: 'desc' },
      });
      const alerts: PeAlertItem[] = rawAlerts.map((a) => ({
        id: a.id,
        changeType: a.changeType,
        severity: a.severity,
        title: a.title,
        description: a.description,
        relatedPeCodes: a.relatedPeCodes,
        detectedAt: a.detectedAt,
      }));

      const summary = {
        mode: commit ? 'COMMIT' : 'DRY_RUN',
        since: since.toISOString(),
        alerts: alerts.length,
        canary: canary.all ? 'all' : [...canary.ids],
        watchlist_links_added: 0,
        users_considered: 0,
        emails: [] as Array<{ to: string; tenantId: string; total: number; critical: number }>,
      };

      if (alerts.length === 0) {
        return { summary, queued: [] as QueuedEmail[] };
      }

      // ── 2. Unified watchlist stamping ────────────────────────────────────
      const peCodes = [...new Set(alerts.flatMap((a) => a.relatedPeCodes))];
      const pes = await tx.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, title: true },
      });
      const capMatches = await tx.capabilityBudgetLineMatch.findMany({
        where: { peCode: { in: peCodes }, status: 'accepted' },
        select: { peCode: true, capability: { select: { name: true, aliases: true } } },
      });
      const capTermsByPe = new Map<string, string[]>();
      for (const m of capMatches) {
        const terms = capTermsByPe.get(m.peCode) ?? [];
        terms.push(m.capability.name, ...m.capability.aliases);
        capTermsByPe.set(m.peCode, terms);
      }
      const watchlistRows = await tx.clientWatchlist.findMany({
        select: { clientId: true, tags: true },
      });
      const watchlists = watchlistRows.map((w) => ({
        clientId: w.clientId,
        tags: parseWatchlistTags(w.tags),
      }));
      const clientsByPe = new Map<string, string[]>();
      for (const pe of pes) {
        clientsByPe.set(
          pe.peCode,
          matchWatchlistClients(
            {
              peCode: pe.peCode,
              title: pe.title ?? '',
              capabilityTerms: capTermsByPe.get(pe.peCode) ?? [],
            },
            watchlists,
          ),
        );
      }
      for (const a of rawAlerts) {
        const matched = [...new Set(a.relatedPeCodes.flatMap((pe) => clientsByPe.get(pe) ?? []))];
        const additions = matched.filter((c) => !a.relatedClientIds.includes(c));
        if (additions.length === 0) continue;
        summary.watchlist_links_added += additions.length;
        if (commit) {
          await tx.intelligenceChange.update({
            where: { id: a.id },
            data: { relatedClientIds: { set: [...a.relatedClientIds, ...additions] } },
          });
        }
      }

      // ── 3. Per-user digests ──────────────────────────────────────────────
      const watches = await tx.programElementWatch.findMany({
        where: { peCode: { in: peCodes } },
        select: {
          userId: true,
          tenantId: true,
          peCode: true,
          user: { select: { email: true } },
        },
      });
      const prefs = await tx.peAlertEmailPref.findMany({
        select: { userId: true, tenantId: true, mode: true },
      });
      const prefByUser = new Map(prefs.map((p) => [`${p.tenantId}:${p.userId}`, p.mode]));

      interface UserAgg {
        tenantId: string;
        email: string;
        watched: Set<string>;
      }
      const users = new Map<string, UserAgg>();
      for (const w of watches) {
        const key = `${w.tenantId}:${w.userId}`;
        const agg = users.get(key) ?? {
          tenantId: w.tenantId,
          email: w.user.email,
          watched: new Set<string>(),
        };
        agg.watched.add(w.peCode);
        users.set(key, agg);
      }
      summary.users_considered = users.size;

      const queued: QueuedEmail[] = [];
      for (const [key, agg] of users) {
        const mode = prefByUser.get(key) ?? 'daily';
        if (mode === 'off') continue;
        if (!canary.all && !canary.ids.has(agg.tenantId)) continue;
        const digest = digestForUser(alerts, agg.watched);
        const total = digest.critical.length + digest.regular.length;
        if (total === 0) continue;

        summary.emails.push({
          to: agg.email,
          tenantId: agg.tenantId,
          total,
          critical: digest.critical.length,
        });
        const { subject, html, text } = renderPeDigestEmail(digest, { appBaseUrl });
        queued.push({ to: agg.email, tenantId: agg.tenantId, subject, html, text, total, critical: digest.critical.length });
      }

      return { summary, queued };
    });

    // Phase B — send outside any transaction. Best-effort: a failed send is
    // logged, never aborts the batch, and the IntelligenceChange rows remain
    // the durable record.
    let sent = 0;
    if (commit && queued.length > 0) {
      const ses = new SESv2Client({ region });
      for (const e of queued) {
        try {
          await ses.send(
            new SendEmailCommand({
              FromEmailAddress: from,
              Destination: { ToAddresses: [e.to] },
              Content: {
                Simple: {
                  Subject: { Data: e.subject, Charset: 'UTF-8' },
                  Body: {
                    Html: { Data: e.html, Charset: 'UTF-8' },
                    Text: { Data: e.text, Charset: 'UTF-8' },
                  },
                },
              },
            }),
          );
          sent += 1;
        } catch (err) {
          console.error(`[send-pe-alert-emails] send to ${e.to} failed: ${(err as Error).message}`);
        }
      }
    }

    console.log(JSON.stringify({ ...summary, emails_sent: sent }, null, 2));
    if (!commit) console.log('DRY RUN — re-run with --commit to stamp + send.');
    return { inserted: sent, updated: summary.watchlist_links_added, skipped: 0, errors: 0 };
  };

  try {
    if (commit) {
      await runWithSyncRun(prisma, SYNC_SOURCE, run);
    } else {
      await run();
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((e) => {
  console.error('[send-pe-alert-emails] fatal', (e as Error)?.stack ?? e);
  process.exit(1);
});
