/** Existing SAM record rematching only. Source ingestion lives in sync-tango-funding.
 * tsx scripts/sync-sam-opportunities.ts --match-only --commit
 * This retained operator command performs no source API requests.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { matchOpportunity, trigrams, type AliasForMatch, type ProposedSamMatch } from './sam-opportunity-matcher.js';
dotenvConfig();

export function parseSamSyncArgs(argv: string[]): { commit: boolean; matchOnly: boolean } {
  if (argv.some(value => !['--commit', '--match-only'].includes(value))) {
    throw new Error('Unsupported rematch option; direct SAM ingestion has been retired');
  }
  return { commit: argv.includes('--commit'), matchOnly: argv.includes('--match-only') };
}
function str(value: unknown): string | null {
  return value == null ? null : String(value).trim() || null;
}
function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function buildAliasIndex(
  aliases: Array<{
    programId: string;
    aliasNormalized: string;
    aliasType: string;
    officeHint?: string | null;
    pscHints?: string[];
  }>,
): AliasForMatch[] {
  return aliases.map((a) => ({
    programId: a.programId,
    aliasNormalized: a.aliasNormalized,
    aliasType: a.aliasType,
    tg: trigrams(a.aliasNormalized),
    officeHint: a.officeHint ?? null,
    pscHints: a.pscHints ? new Set(a.pscHints.map((p) => p.toUpperCase())) : undefined,
  }));
}

type SamMatchPersistenceClient = Pick<Prisma.TransactionClient, 'samOpportunityMatch'>;

type ExistingSamMatch = {
  id: string;
  matchBasis: string;
  confidence: number;
  reviewStatus: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function persistOneMatch(
  client: SamMatchPersistenceClient,
  opportunityId: string,
  match: ProposedSamMatch,
): Promise<number> {
  const where = {
    opportunityId,
    programId: match.programId,
    peCode: match.peCode,
  };
  const select = {
    id: true,
    matchBasis: true,
    confidence: true,
    reviewStatus: true,
  } as const;

  const applyExisting = async (existing: ExistingSamMatch): Promise<number> => {
    // Human review decisions are terminal for machine reruns. Do not touch updatedAt,
    // confidence, basis, or status: accepted and rejected rows remain explicit decisions.
    if (existing.reviewStatus === 'rejected' || existing.reviewStatus === 'accepted') return 0;

    // Same evidence basis: refresh confidence and Prisma's updatedAt while preserving
    // the existing review status. The schema has no reviewer/machine-author column, so
    // preserving status is the only safe behavior for both human-accepted and machine
    // candidate rows.
    if (existing.matchBasis === match.matchBasis) {
      await client.samOpportunityMatch.update({
        where: { id: existing.id },
        data: { confidence: match.confidence },
      });
      return 1;
    }

    // A changed machine basis must not rewrite an existing human-visible decision.
    // The proposed evidence will be reconsidered only through a separately keyed row
    // (programId/peCode) or a future explicit review workflow.
    return 0;
  };

  const existing = await client.samOpportunityMatch.findFirst({ where, select });
  if (existing) return applyExisting(existing);

  try {
    await client.samOpportunityMatch.create({
      data: {
        opportunityId,
        programId: match.programId,
        peCode: match.peCode,
        matchBasis: match.matchBasis,
        confidence: match.confidence,
        reviewStatus: match.reviewStatus,
      },
    });
    return 1;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Another worker won the functional-natural-key race. Re-read and apply the
    // same review-preserving update instead of creating a duplicate or returning 500.
    const raced = await client.samOpportunityMatch.findFirst({ where, select });
    if (!raced) throw error;
    return applyExisting(raced);
  }
}

/**
 * Persist proposed matches without overwriting human review decisions. The functional
 * natural key prevents duplicate opportunity/program/PE rows; a race is re-read and
 * handled idempotently.
 */
export async function persistMatches(
  client: SamMatchPersistenceClient,
  opportunityId: string,
  proposed: ProposedSamMatch[],
): Promise<number> {
  let written = 0;
  for (const match of proposed) {
    written += await persistOneMatch(client, opportunityId, match);
  }
  return written;
}

export function descriptionForMatching(description: string | null): string | null {
  const value = str(description);
  return value && looksLikeUrl(value) ? null : value;
}

async function main(): Promise<void> {
  const { commit, matchOnly } = parseSamSyncArgs(process.argv.slice(2));
  if (!matchOnly) throw new Error('Direct SAM ingestion retired; use sync-tango-funding. This command retains --match-only for existing operator workflows.');
  const prisma = new PrismaClient();
  try { await rematchExisting(prisma, commit); } finally { await prisma.$disconnect(); }
}

async function rematchExisting(prisma: PrismaClient, commit: boolean): Promise<void> {
  const t0 = Date.now();
  console.log(
    `[sam-opportunities] MATCH-ONLY re-match over existing opportunities (${commit ? 'COMMIT' : 'DRY-RUN'})`,
  );

  const pes = await prisma.programElement.findMany({ select: { peCode: true } });
  const knownPeCodes = new Set<string>(pes.map((p) => p.peCode.toUpperCase()));
  const aliasRows = await prisma.programAlias.findMany({
    select: { programId: true, aliasNormalized: true, aliasType: true },
  });
  const aliasIndex = buildAliasIndex(aliasRows);
  console.log(
    `[sam-opportunities] ${knownPeCodes.size} known PEs, ${aliasIndex.length} program aliases`,
  );

  const BATCH = 1000;
  let scanned = 0;
  let withProposed = 0;
  let matchesWritten = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.samOpportunity.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        office: true,
        pscCode: true,
        naicsCode: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const runMatch = () =>
        matchOpportunity(
          {
            title: row.title,
            description: descriptionForMatching(row.description),
            office: row.office,
            pscCode: row.pscCode,
            naicsCode: row.naicsCode,
          },
          knownPeCodes,
          aliasIndex,
        );
      if (commit) {
        const result = await prisma.$transaction(async (tx) => {
          const proposed = runMatch();
          return { proposed: proposed.length, written: await persistMatches(tx, row.id, proposed) };
        });
        if (result.proposed > 0) withProposed += 1;
        matchesWritten += result.written;
      } else {
        if (runMatch().length > 0) withProposed += 1;
      }
      scanned += 1;
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[sam-opportunities] MATCH-ONLY done: scanned=${scanned} ` +
      `opportunitiesWithProposedMatch=${withProposed} matchesWritten=${matchesWritten} ` +
      `(${commit ? 'COMMITTED' : 'DRY-RUN, nothing written'}) in ${elapsed}s`,
  );
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-sam-opportunities(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-sam-opportunities.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  void main().catch((err) => {
    console.error('[sam-opportunities] FAILED', err);
    process.exit(1);
  });
}

export { main };
