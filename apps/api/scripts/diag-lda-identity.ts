/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only LDA IDENTITY report. Answers the question: does the Senate-assigned
 * lda_filing.client_id give us a stable identity for a real-world client, or do
 * we still have a name-resolution problem?
 *
 * It measures two things:
 *   (1) within-id name drift  -- how many client_ids carry >1 typed client_name
 *       (i.e. does the SAME id ever show multiple spellings?)
 *   (2) cross-id fragmentation -- how many distinct client_ids map to the SAME
 *       normalized company name (i.e. one real company filed by N firms => N ids).
 *       Normalization mirrors EntityResolutionService.fingerprint(): lowercase,
 *       strip punctuation, strip legal-suffix tokens, collapse whitespace.
 *
 * SAFE: SELECT-only. No writes. Run as a one-off ECS task:
 *   aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"api","command":["diag-lda-identity"]}]}'
 */
import { PrismaClient } from '@prisma/client';

// Pure-SQL approximation of EntityResolutionService.fingerprint(), no backslashes
// so it survives shell/ECS command quoting unharmed.
const NORM = `trim(regexp_replace(
  regexp_replace(
    ' ' || regexp_replace(lower(client_name), '[^a-z0-9 ]', ' ', 'g') || ' ',
    ' (inc|llc|corp|corporation|ltd|co|lp|llp|pa|pc|pllc|company|the) ', ' ', 'g'),
  ' +', ' ', 'g'))`;

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-lda-identity.ts requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.length > 0) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
      return prisma.$queryRawUnsafe<T[]>(sql);
    };

    const out: Record<string, unknown> = {};

    out.overall = (
      await q(`select count(*)::int filings,
                    count(distinct client_id)::int distinct_client_ids,
                    count(distinct client_name)::int distinct_client_names,
                    count(distinct registrant_id)::int distinct_registrants
               from lda_filing`)
    )[0];

    // (1) Within-id name drift.
    out.within_id_drift = (
      await q(`select count(*)::int client_ids_with_multiple_names
               from (select client_id from lda_filing
                      where client_id is not null
                      group by client_id
                     having count(distinct client_name) > 1) t`)
    )[0];

    out.within_id_examples = await q(
      `select client_id,
            count(distinct client_name)::int name_variants,
            string_agg(distinct client_name, ' | ') names
       from lda_filing
      where client_id is not null
      group by client_id
     having count(distinct client_name) > 1
      order by 2 desc
      limit 8`,
    );

    // (2) Cross-id fragmentation: one normalized company -> many client_ids.
    out.fragmentation_summary = (
      await q(`select count(*)::int companies_with_multiple_ids,
                    coalesce(sum(distinct_ids), 0)::int total_ids_in_those_companies,
                    coalesce(max(distinct_ids), 0)::int worst_single_company
               from (select count(distinct client_id) distinct_ids
                       from lda_filing
                      where client_name <> ''
                      group by ${NORM}
                     having count(distinct client_id) > 1) t`)
    )[0];

    out.fragmentation_examples = await q(
      `select ${NORM} norm,
            count(distinct client_id)::int distinct_ids,
            count(distinct registrant_id)::int distinct_firms,
            left(string_agg(distinct client_name, ' | '), 400) sample_names
       from lda_filing
      where client_name <> ''
      group by ${NORM}
     having count(distinct client_id) > 1
      order by 2 desc
      limit 12`,
    );

    console.log(
      'LDA_IDENTITY_REPORT ' +
        JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, (_k, v) => num(v), 2),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('LDA_IDENTITY_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
