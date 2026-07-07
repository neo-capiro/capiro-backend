/**
 * match-pe-mentions — hearing-transcript PE mentions + bill-title candidate
 * links (PE Watch auto-update plan, Phase 3;
 * docs/plans/2026-07-06-pe-watch-auto-update-plan.md).
 *
 *   match-pe-mentions                      # DRY RUN (default): print summary, write nothing
 *   match-pe-mentions --commit             # write IntelligenceChange mention rows + candidate links
 *   flags: --limit N            transcripts per run (default 50, newest fetchedAt first)
 *          --since YYYY-MM-DD   window override (default: last 30 days)
 *
 * Name bank (all curated / accepted-only sources):
 *   program_name      (0.90) — Program.canonicalName via ACCEPTED pe_program_match rows
 *   capability_alias  (0.70) — Capability.name + aliases via ACCEPTED capability_budget_line_match rows
 *   pe_title          (0.55) — ProgramElement.title (retiredAt null only)
 *
 * Hearing mentions land as IntelligenceChange rows (source='pe_hearing_mention',
 * changeType='hearing_mention', one row per transcript × PE, dedupeKey
 * 'mention:<transcriptId>:<peCode>' — re-runs are no-ops). Bill-title matches
 * land as bill_budget_line_link rows with status='candidate',
 * linkType='title_match', derivedBy='match-pe-mentions@v1'. NOTHING here
 * auto-accepts, and only this script's own candidate cohort is ever updated —
 * rows with another derivedBy/linkType or a human-reviewed status are skipped.
 *
 * Commit runs wrap in runWithSyncRun('match-pe-mentions'); dry runs never
 * write a SyncRun row. Exits 0 with a JSON summary.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  aggregateMentionsByPe,
  buildNameBank,
  findMentions,
  matchBillTitles,
  mentionDedupeKey,
  mentionSeverity,
  type BillLinkCandidate,
  type NameBank,
  type NameBankEntryInput,
} from '../src/program-element/pe-mention-matcher/pe-mention-matcher.js';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const SYNC_SOURCE = 'match-pe-mentions';
const DERIVED_BY = 'match-pe-mentions@v1';
const LINK_TYPE = 'title_match';
const MENTION_SOURCE = 'pe_hearing_mention';
const DEFAULT_LIMIT = 50;
const DEFAULT_WINDOW_DAYS = 30;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Bank rows from the three curated sources (accepted matches only). */
async function loadNameBankEntries(prisma: PrismaClient): Promise<NameBankEntryInput[]> {
  const entries: NameBankEntryInput[] = [];

  const programMatches = await prisma.peProgramMatch.findMany({
    where: { status: 'accepted' },
    select: { peCode: true, program: { select: { canonicalName: true } } },
  });
  for (const m of programMatches) {
    entries.push({ peCode: m.peCode, term: m.program.canonicalName, tier: 'program_name' });
  }

  const capabilityMatches = await prisma.capabilityBudgetLineMatch.findMany({
    where: { status: 'accepted' },
    select: { peCode: true, capability: { select: { name: true, aliases: true } } },
  });
  for (const m of capabilityMatches) {
    for (const term of [m.capability.name, ...m.capability.aliases]) {
      entries.push({ peCode: m.peCode, term, tier: 'capability_alias' });
    }
  }

  const peTitles = await prisma.programElement.findMany({
    where: { retiredAt: null },
    select: { peCode: true, title: true },
  });
  for (const pe of peTitles) {
    entries.push({ peCode: pe.peCode, term: pe.title, tier: 'pe_title' });
  }

  return entries;
}

interface MentionRow {
  dedupeKey: string;
  transcriptId: string;
  hearingId: string | null;
  committeeName: string | null;
  transcriptTitle: string;
  peCode: string;
  matchedTerm: string;
  tier: string;
  confidence: number;
  occurrences: number;
  severity: 'info' | 'notable';
  snippet: string;
}

/**
 * Scan the transcript window. Texts run ~1MB, so ids/metadata are listed first
 * and each text is loaded one transcript at a time (bounded memory).
 */
async function scanTranscripts(
  prisma: PrismaClient,
  bank: NameBank,
  since: Date,
  limit: number,
): Promise<{ transcriptsScanned: number; rawMentions: number; rows: MentionRow[] }> {
  const transcripts = await prisma.officialHearingTranscript.findMany({
    where: { fetchedAt: { gte: since } },
    orderBy: { fetchedAt: 'desc' },
    take: limit,
    select: { id: true, hearingId: true, committeeName: true, title: true },
  });

  const rows: MentionRow[] = [];
  let rawMentions = 0;
  for (const t of transcripts) {
    const withText = await prisma.officialHearingTranscript.findUnique({
      where: { id: t.id },
      select: { text: true },
    });
    if (!withText?.text) continue;
    const mentions = findMentions(withText.text, bank);
    rawMentions += mentions.length;
    for (const summary of aggregateMentionsByPe(mentions)) {
      rows.push({
        dedupeKey: mentionDedupeKey(t.id, summary.peCode),
        transcriptId: t.id,
        hearingId: t.hearingId,
        committeeName: t.committeeName,
        transcriptTitle: t.title,
        peCode: summary.peCode,
        matchedTerm: summary.matchedTerm,
        tier: summary.tier,
        confidence: summary.confidence,
        occurrences: summary.occurrences,
        severity: mentionSeverity(summary.occurrences),
        snippet: summary.snippet,
      });
    }
  }
  return { transcriptsScanned: transcripts.length, rawMentions, rows };
}

/** Existing mention dedupe keys (top-level column, falling back to data copy). */
async function loadKnownMentionKeys(prisma: PrismaClient): Promise<Set<string>> {
  const existing = await prisma.intelligenceChange.findMany({
    where: { source: MENTION_SOURCE },
    select: { dedupeKey: true, data: true },
  });
  const known = new Set<string>();
  for (const row of existing) {
    const key = row.dedupeKey ?? (row.data as { dedupeKey?: string } | null)?.dedupeKey;
    if (key) known.add(key);
  }
  return known;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Write mention rows; P2002 (concurrent duplicate) counts as deduped. */
async function writeMentionRows(
  prisma: PrismaClient,
  rows: MentionRow[],
): Promise<{ written: number; raced: number }> {
  let written = 0;
  let raced = 0;
  for (const row of rows) {
    try {
      await prisma.intelligenceChange.create({
        data: {
          dedupeKey: row.dedupeKey,
          source: MENTION_SOURCE,
          changeType: 'hearing_mention',
          severity: row.severity,
          title: `PE ${row.peCode} mentioned in hearing: ${truncate(row.transcriptTitle, 140)}`,
          description: `"${row.matchedTerm}" (${row.tier}, ${row.occurrences}x) — ${row.snippet}`,
          relatedPeCodes: [row.peCode],
          data: {
            dedupeKey: row.dedupeKey,
            transcriptId: row.transcriptId,
            hearingId: row.hearingId,
            committeeName: row.committeeName,
            matchedTerm: row.matchedTerm,
            tier: row.tier,
            confidence: row.confidence,
            snippet: row.snippet,
            occurrences: row.occurrences,
          } as Prisma.InputJsonValue,
        },
      });
      written += 1;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        raced += 1;
        continue;
      }
      throw e;
    }
  }
  return { written, raced };
}

interface BillLinkPlan {
  create: BillLinkCandidate[];
  update: BillLinkCandidate[];
  skippedExplicitCode: number;
  skippedExistingLink: number;
  skippedReviewed: number;
  unchanged: number;
}

/**
 * Decide what to do with each bill-title candidate. This script manages ONLY
 * its own cohort (linkType='title_match', derivedBy='match-pe-mentions@v1',
 * status='candidate'); every other (billId, peCode) link row causes a skip.
 */
async function planBillLinks(
  prisma: PrismaClient,
  candidates: BillLinkCandidate[],
  explicitPeCodesByBill: Map<string, Set<string>>,
): Promise<BillLinkPlan> {
  const plan: BillLinkPlan = {
    create: [],
    update: [],
    skippedExplicitCode: 0,
    skippedExistingLink: 0,
    skippedReviewed: 0,
    unchanged: 0,
  };
  if (candidates.length === 0) return plan;

  const billIds = [...new Set(candidates.map((c) => c.billId))];
  const links = await prisma.billBudgetLineLink.findMany({
    where: { billId: { in: billIds } },
    select: {
      billId: true,
      peCode: true,
      linkType: true,
      status: true,
      derivedBy: true,
      confidence: true,
      evidence: true,
    },
  });
  const linksByPair = new Map<string, typeof links>();
  for (const link of links) {
    const key = `${link.billId}|${link.peCode}`;
    const list = linksByPair.get(key);
    if (list) list.push(link);
    else linksByPair.set(key, [link]);
  }

  for (const candidate of candidates) {
    // Explicit-code extraction already linked this pair — a fuzzy candidate adds nothing.
    if (explicitPeCodesByBill.get(candidate.billId)?.has(candidate.peCode)) {
      plan.skippedExplicitCode += 1;
      continue;
    }
    const pairLinks = linksByPair.get(`${candidate.billId}|${candidate.peCode}`) ?? [];
    const foreign = pairLinks.find((l) => l.linkType !== LINK_TYPE || l.derivedBy !== DERIVED_BY);
    if (foreign) {
      plan.skippedExistingLink += 1;
      continue;
    }
    const own = pairLinks.find((l) => l.linkType === LINK_TYPE && l.derivedBy === DERIVED_BY);
    if (!own) {
      plan.create.push(candidate);
      continue;
    }
    if (own.status !== 'candidate') {
      // A human accepted/rejected our candidate — never touch it again.
      plan.skippedReviewed += 1;
      continue;
    }
    if (own.confidence === candidate.confidence && own.evidence === candidate.evidence) {
      plan.unchanged += 1;
      continue;
    }
    plan.update.push(candidate);
  }
  return plan;
}

async function writeBillLinks(prisma: PrismaClient, plan: BillLinkPlan): Promise<void> {
  for (const candidate of [...plan.create, ...plan.update]) {
    await prisma.billBudgetLineLink.upsert({
      where: {
        billId_peCode_linkType: {
          billId: candidate.billId,
          peCode: candidate.peCode,
          linkType: LINK_TYPE,
        },
      },
      create: {
        billId: candidate.billId,
        peCode: candidate.peCode,
        linkType: LINK_TYPE,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        evidenceJson: {
          term: candidate.term,
          tier: candidate.tier,
          matchedBy: DERIVED_BY,
        } as Prisma.InputJsonValue,
        status: 'candidate',
        derivedBy: DERIVED_BY,
      },
      update: {
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        evidenceJson: {
          term: candidate.term,
          tier: candidate.tier,
          matchedBy: DERIVED_BY,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

async function main(): Promise<void> {
  const commit = flag('commit');

  const limitArg = arg('limit');
  const limit = limitArg ? Number(limitArg) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`Invalid --limit ${limitArg}`);
    process.exit(1);
  }

  const sinceArg = arg('since');
  if (sinceArg && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
    console.error(`Invalid --since ${sinceArg} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const since = sinceArg
    ? new Date(`${sinceArg}T00:00:00Z`)
    : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000);

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const run = async (): Promise<RunCounts> => {
      // ── name bank ────────────────────────────────────────────────────
      const bankInputs = await loadNameBankEntries(prisma);
      const bank = buildNameBank(bankInputs);

      // ── hearing-transcript mentions ──────────────────────────────────
      const { transcriptsScanned, rawMentions, rows } = await scanTranscripts(
        prisma,
        bank,
        since,
        limit,
      );
      const knownKeys = await loadKnownMentionKeys(prisma);
      const freshRows = rows.filter((r) => !knownKeys.has(r.dedupeKey));
      const deduped = rows.length - freshRows.length;

      // ── bill-title matching ──────────────────────────────────────────
      const bills = await prisma.congressBill.findMany({
        where: { latestActionDate: { gte: since } },
        select: { id: true, title: true, peCodes: true },
      });
      const explicitPeCodesByBill = new Map<string, Set<string>>(
        bills.map((b) => [b.id, new Set(b.peCodes)]),
      );
      const candidates = matchBillTitles(
        bills.map((b) => ({ billId: b.id, title: b.title })),
        bank,
      );
      const billPlan = await planBillLinks(prisma, candidates, explicitPeCodesByBill);

      const summary = {
        mode: commit ? 'COMMIT' : 'DRY_RUN',
        since: since.toISOString(),
        limit,
        bank_terms: bank.entries.length,
        bank_terms_rejected: bank.rejectedCount,
        transcripts_scanned: transcriptsScanned,
        mentions_found: rawMentions,
        pe_mention_rows: rows.length,
        deduped,
        [commit ? 'writing' : 'would_write']: freshRows.length,
        samples: freshRows.slice(0, 10).map((r) => ({
          transcriptId: r.transcriptId,
          peCode: r.peCode,
          matchedTerm: r.matchedTerm,
          tier: r.tier,
          occurrences: r.occurrences,
          severity: r.severity,
          snippet: truncate(r.snippet, 200),
        })),
        bills_scanned: bills.length,
        bill_candidates: candidates.length,
        bill_skipped_explicit_code: billPlan.skippedExplicitCode,
        bill_skipped_existing_link: billPlan.skippedExistingLink,
        bill_skipped_reviewed: billPlan.skippedReviewed,
        bill_unchanged: billPlan.unchanged,
        [commit ? 'bill_links_creating' : 'bill_links_would_create']: billPlan.create.length,
        [commit ? 'bill_links_updating' : 'bill_links_would_update']: billPlan.update.length,
        bill_samples: [...billPlan.create, ...billPlan.update].slice(0, 10).map((c) => ({
          billId: c.billId,
          peCode: c.peCode,
          term: c.term,
          tier: c.tier,
          confidence: c.confidence,
        })),
      };
      console.log(JSON.stringify(summary, null, 2));

      if (!commit) {
        console.log('DRY RUN — re-run with --commit to write mention rows + candidate links.');
        return { ...emptyCounts(), skipped: freshRows.length + billPlan.create.length };
      }

      const { written, raced } = await writeMentionRows(prisma, freshRows);
      await writeBillLinks(prisma, billPlan);
      console.log(
        JSON.stringify({
          mention_rows_written: written,
          mention_rows_raced: raced,
          bill_links_created: billPlan.create.length,
          bill_links_updated: billPlan.update.length,
        }),
      );
      return {
        inserted: written + billPlan.create.length,
        updated: billPlan.update.length,
        skipped:
          deduped +
          raced +
          billPlan.skippedExplicitCode +
          billPlan.skippedExistingLink +
          billPlan.skippedReviewed +
          billPlan.unchanged,
        errors: 0,
      };
    };

    if (commit) {
      await runWithSyncRun(prisma, SYNC_SOURCE, run);
    } else {
      await run();
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error('[match-pe-mentions] fatal', (e as Error)?.stack ?? e);
  process.exit(1);
});
