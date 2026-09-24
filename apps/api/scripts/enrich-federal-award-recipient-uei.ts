/**
 * Row-by-row recipient_uei enrichment for federal_award rows that predate the
 * 2026-09-21 fix to sync-federal-award.ts (commit b894213dc), which added
 * 'Recipient UEI' to the USASpending search fields list — before that, the
 * column was always null for every synced row.
 *
 * Gate 2 (pre-R5 closeout), L3Harris/FL-08 UEI gap: rather than re-running the
 * bulk DoD sync (unbounded, years of action-date history, no recipient
 * filter), this verifies each candidate row individually against
 * USASpending's live single-award endpoint before writing anything — an
 * authoritative per-row check, not a bulk re-fetch.
 *
 *   tsx scripts/enrich-federal-award-recipient-uei.ts --recipient="L3HARRIS" [--limit=N]
 *   (dry-run by default; add --commit to persist)
 *
 * SAFE: only ever fills a NULL recipient_uei with a value confirmed live from
 * USASpending for that exact award_unique_id. Never touches a row that
 * already has a UEI, never invents one, never widens matching beyond the
 * exact award being checked.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const p = `--${name}`;
  const eq = process.argv.find((a) => a.startsWith(`${p}=`));
  if (eq) return eq.slice(p.length + 1);
  const i = process.argv.indexOf(p);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function fetchLiveUei(awardUniqueId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(awardUniqueId)}/`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { recipient?: { recipient_uei?: string | null } };
  const uei = body.recipient?.recipient_uei;
  return uei && /^[A-Z0-9]{12}$/i.test(uei) ? uei.toUpperCase() : null;
}

async function main(): Promise<void> {
  const recipientPattern = arg('recipient') ?? 'L3HARRIS';
  const limit = Number(arg('limit') ?? '200');
  const commit = process.argv.includes('--commit');

  const candidates = await prisma.federalAward.findMany({
    where: {
      recipientUei: null,
      contractorName: { contains: recipientPattern, mode: 'insensitive' },
    },
    select: { id: true, awardUniqueId: true, piid: true, contractorName: true, popState: true, popCongressionalDistrict: true },
    take: limit,
  });

  console.log(
    `Found ${candidates.length} candidate row(s) matching contractor_name ILIKE '%${recipientPattern}%' AND recipient_uei IS NULL (limit ${limit}).`,
  );

  let verified = 0;
  let sourceStillMissing = 0;
  let updated = 0;
  const sourceUeis = new Set<string>();

  for (const row of candidates) {
    const liveUei = await fetchLiveUei(row.awardUniqueId);
    if (!liveUei) {
      sourceStillMissing++;
      console.log(`  SKIP  ${row.piid ?? row.awardUniqueId} (${row.contractorName}) — live source still has no UEI`);
      continue;
    }
    verified++;
    sourceUeis.add(liveUei);
    console.log(
      `  ${commit ? 'ENRICH' : 'WOULD ENRICH'}  ${row.piid ?? row.awardUniqueId} (${row.contractorName}, ${row.popState ?? '?'}-${row.popCongressionalDistrict ?? '?'}) -> ${liveUei}`,
    );
    if (commit) {
      // updateMany (not update) so the where clause can re-assert NULL at
      // write time as a general filter, not just a unique-key lookup — never
      // overwrite a value some concurrent process already set.
      const result = await prisma.federalAward.updateMany({
        where: { id: row.id, recipientUei: null },
        data: { recipientUei: liveUei },
      });
      if (result.count === 1) updated++;
      else console.log(`    WRITE_SKIPPED (row no longer null — set by something else concurrently)`);
    }
    // USASpending's per-IP rate limit is generous for the single-award detail
    // endpoint, but stay polite on a loop of individually-verified requests.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\n${commit ? 'COMMITTED' : 'DRY RUN — pass --commit to persist'}: candidates=${candidates.length} ` +
      `verifiedAgainstLiveSource=${verified} sourceStillMissing=${sourceStillMissing} ` +
      `${commit ? `actuallyUpdated=${updated}` : ''} distinctUeisSeen=${sourceUeis.size}`,
  );
}

main()
  .catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
