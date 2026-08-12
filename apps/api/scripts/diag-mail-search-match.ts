/**
 * Read-only mail-content match diagnostic. Runs the EXACT same ILIKE predicate
 * as MeriToolsService.searchEmails' `query` branch against one connection's
 * synced mail, to distinguish "the matcher missed real data" from "the data
 * was never synced" when a user reports search_emails returning 0 results.
 *
 *   diag-mail-search-match --account=<email> --term="Power Interactive"
 *
 * SAFE: SELECT-only. No writes. Prints subject/from/date only, never body
 * text, to avoid putting message content in CloudWatch logs.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : undefined;
}

async function main(): Promise<void> {
  const account = arg('account');
  const term = arg('term');
  if (!account || !term) {
    throw new Error('usage: diag-mail-search-match --account=<email> --term=<substring>');
  }
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    const conn = await tx.$queryRaw<Array<{ id: string; account_email: string; status: string }>>(
      Prisma.sql`SELECT id::text AS id, account_email::text AS account_email, status
                 FROM engagement_connections WHERE account_email::text ILIKE ${account} LIMIT 5`,
    );
    console.log('MS_CONNECTIONS ' + JSON.stringify(conn));
    if (!conn.length) {
      console.log('MS_DONE ' + JSON.stringify({ matched: 0, note: 'no connection with that account_email' }));
      return;
    }

    const total = await tx.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM mail_messages m
                 JOIN engagement_connections c ON c.id = m.connection_id
                 WHERE c.account_email::text ILIKE ${account}`,
    );
    console.log('MS_TOTAL_SYNCED ' + JSON.stringify(total[0]));

    // Same predicate as searchEmails' `query` branch, minus tenant/user scoping
    // (this script already scopes by account_email directly).
    const matches = await tx.$queryRaw<
      Array<{ subject: string | null; from_email: string | null; from_name: string | null; received_at: Date | null; sent_at: Date | null; folder: string | null }>
    >(Prisma.sql`
      SELECT m.subject, m.from_email::text AS from_email, m.from_name,
             m.received_at, m.sent_at, m.metadata_jsonb->>'folder' AS folder
      FROM mail_messages m
      JOIN engagement_connections c ON c.id = m.connection_id
      WHERE c.account_email::text ILIKE ${account}
        AND (m.subject ILIKE ${pattern} OR m.body_text ILIKE ${pattern}
             OR m.from_email::text ILIKE ${pattern} OR m.from_name ILIKE ${pattern}
             OR m.to_recipients_jsonb::text ILIKE ${pattern}
             OR m.cc_recipients_jsonb::text ILIKE ${pattern})
      ORDER BY COALESCE(m.received_at, m.sent_at) DESC NULLS LAST
      LIMIT 25
    `);
    console.log('MS_MATCHES ' + JSON.stringify({ count: matches.length, rows: matches }, null, 2));

    // Broader sweep: does the raw term appear ANYWHERE (any field, any case)
    // even outside the exact same-predicate check above, to catch a predicate
    // bug rather than a data-absence answer.
    const looseTerm = term.split(/\s+/)[0] ?? term;
    const loosePattern = `%${looseTerm.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const loose = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM mail_messages m
      JOIN engagement_connections c ON c.id = m.connection_id
      WHERE c.account_email::text ILIKE ${account}
        AND (m.subject ILIKE ${loosePattern} OR m.body_text ILIKE ${loosePattern}
             OR m.from_name ILIKE ${loosePattern})
    `);
    console.log('MS_LOOSE_FIRST_WORD ' + JSON.stringify({ term: looseTerm, n: loose[0]?.n ?? 0 }));

    console.log('MS_DONE ' + JSON.stringify({ matched: matches.length }));
  });
}

main()
  .catch((err) => {
    console.error('MS_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
