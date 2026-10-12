/**
 * Emit semantic per-bill IntelligenceChange alerts when a relevant bill crosses
 * a meaningful legislative stage (markup, reported, passed a chamber, sent to
 * the President, became law).
 *
 * Unlike emit-changes.ts (which emits a coarse "N new bills synced" count),
 * this surfaces INDIVIDUAL bills that advanced, mapped to the clients they
 * touch via PE codes and issue codes. These feed the dashboard "Needs
 * Attention" banner (source=congress_bill, changeType=bill_*).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-bill-alerts.ts
 *
 * Run after sync-congress. Dedupes per (bill, stage) over a 14-day window so
 * re-runs don't spam the feed. No schema changes — reads congress_bill +
 * client_capabilities, writes intelligence_change.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();

interface Stage {
  changeType: string;
  label: string;
  severity: string;
}

// Classify a bill's latest action text into a significant stage, or null for
// routine actions (introduced, referred to committee, etc.) we don't alert on.
function classifyStage(text: string | null): Stage | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/became (public )?law|public law no|signed by (the )?president/.test(t))
    return { changeType: 'bill_enacted', label: 'Became law', severity: 'critical' };
  if (/presented to (the )?president|cleared for white house/.test(t))
    return { changeType: 'bill_to_president', label: 'Sent to President', severity: 'critical' };
  if (
    /passed\/agreed to in (the )?(house|senate)|passed (the )?(house|senate)|on passage[^.]*passed|agreed to in (the )?(house|senate)/.test(
      t,
    )
  )
    return { changeType: 'bill_passed_chamber', label: 'Passed a chamber', severity: 'notable' };
  if (/ordered to be reported|reported (by|to|favorably)|placed on (the )?[a-z ]*calendar/.test(t))
    return { changeType: 'bill_reported', label: 'Reported / on calendar', severity: 'notable' };
  if (/markup|marked up|committee consideration and mark/.test(t))
    return { changeType: 'bill_markup', label: 'Markup', severity: 'notable' };
  return null;
}

function billLabel(billType: string, billNumber: string): string {
  const map: Record<string, string> = {
    hr: 'H.R.',
    s: 'S.',
    hjres: 'H.J.Res.',
    sjres: 'S.J.Res.',
    hconres: 'H.Con.Res.',
    sconres: 'S.Con.Res.',
    hres: 'H.Res.',
    sres: 'S.Res.',
  };
  const prefix = map[billType.toLowerCase()] ?? billType.toUpperCase();
  return `${prefix} ${billNumber}`;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

async function main() {
  // Anchor the recency window to the freshest action date actually present in
  // the data, not the wall clock. In real-time prod the newest action date is
  // ~today, so this behaves like a normal "last N days" window; if the system
  // clock runs ahead of the latest available Congress.gov data, anchoring to
  // the data still surfaces the genuinely most-recent bill movements.
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/emit-bill-alerts.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const lookbackDays = 7;
    const maxAgg = await prisma.congressBill.aggregate({ _max: { latestActionDate: true } });
    const anchorDate = maxAgg._max.latestActionDate ?? new Date();
    const sinceDate = new Date(anchorDate);
    sinceDate.setDate(sinceDate.getDate() - lookbackDays);
    sinceDate.setHours(0, 0, 0, 0);
    const dedupeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    console.log(
      `[emit-bill-alerts] anchor=${anchorDate.toISOString().slice(0, 10)} ` +
        `scanning bills with action since ${sinceDate.toISOString().slice(0, 10)}`,
    );

    const bills = await prisma.congressBill.findMany({
      where: { latestActionDate: { gte: sinceDate } },
      select: {
        id: true,
        billType: true,
        billNumber: true,
        title: true,
        latestActionText: true,
        latestActionDate: true,
        peCodes: true,
        subjects: true,
        policyArea: true,
        url: true,
      },
    });

    // Load capabilities once for relevance matching (cross-tenant — the changes
    // query re-filters per tenant, so populating relatedClientIds is enough).
    const caps = await prisma.clientCapability.findMany({
      select: { clientId: true, peNumber: true, issueCodes: true },
    });
    const capByPe = new Map<string, Set<string>>();
    const capByIssue = new Map<string, Set<string>>();
    for (const c of caps) {
      if (c.peNumber) {
        const set = capByPe.get(c.peNumber) ?? new Set<string>();
        set.add(c.clientId);
        capByPe.set(c.peNumber, set);
      }
      for (const code of asStringArray(c.issueCodes)) {
        const set = capByIssue.get(code) ?? new Set<string>();
        set.add(c.clientId);
        capByIssue.set(code, set);
      }
    }

    let emitted = 0;
    for (const bill of bills) {
      const stage = classifyStage(bill.latestActionText);
      if (!stage) continue;

      // Relevance: clients whose capability PE numbers or issue codes intersect.
      const clientIds = new Set<string>();
      const matchedIssues = new Set<string>();
      for (const pe of bill.peCodes) {
        for (const cid of capByPe.get(pe) ?? []) clientIds.add(cid);
      }
      const billIssueTokens = [...bill.subjects, ...(bill.policyArea ? [bill.policyArea] : [])];
      for (const tok of billIssueTokens) {
        const hit = capByIssue.get(tok);
        if (hit) {
          for (const cid of hit) clientIds.add(cid);
          matchedIssues.add(tok);
        }
      }

      // Dedupe per (bill, stage) within the window so re-runs don't spam.
      const existing = await prisma.intelligenceChange.findFirst({
        where: {
          source: 'congress_bill',
          changeType: stage.changeType,
          detectedAt: { gte: dedupeSince },
          data: { path: ['bill_id'], equals: bill.id },
        },
        select: { id: true },
      });
      if (existing) continue;

      const label = billLabel(bill.billType, bill.billNumber);
      await prisma.intelligenceChange.create({
        data: {
          source: 'congress_bill',
          changeType: stage.changeType,
          severity: stage.severity,
          title: `${label}: ${stage.label}`,
          description: bill.latestActionText ?? `${label} — ${bill.title}`,
          relatedClientIds: [...clientIds],
          relatedIssues: [...matchedIssues],
          relatedPeCodes: bill.peCodes,
          data: {
            bill_id: bill.id,
            stage: stage.label,
            bill_title: bill.title,
            action_date: bill.latestActionDate
              ? bill.latestActionDate.toISOString().slice(0, 10)
              : null,
            url: bill.url ?? null,
          },
        },
      });
      emitted++;
      console.log(`[emit-bill-alerts] ${label} → ${stage.label} (${clientIds.size} client match)`);
    }

    console.log(
      `[emit-bill-alerts] done. Emitted ${emitted} bill alert(s) from ${bills.length} recently-actioned bill(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
