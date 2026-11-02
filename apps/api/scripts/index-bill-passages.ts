/** @cleanup-smoke noArgsExit=2 */
/** Targeted index rollout: never invokes unrelated pending Prisma migrations. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

type Index = {
  name: string;
  valid: boolean;
  ready: boolean;
  table: string;
  method: string;
  keys: number;
  opclass: string;
  column: string | null;
  expression: string | null;
  predicate: string;
};
const names = [
  'context_embeddings_bill_passage_tsv_idx',
  'context_embeddings_bill_passage_hnsw_idx',
];
const compact = (s: string) => s.replace(/::(?:text|regconfig)/g, '').replace(/[\s()]/g, '');
export function verifyIndexes(rows: Index[]) {
  for (const r of rows) {
    const lexical = r.name === names[0];
    if (
      !names.includes(r.name) ||
      !r.valid ||
      !r.ready ||
      r.table !== 'context_embeddings' ||
      r.keys !== 1 ||
      r.method !== (lexical ? 'gin' : 'hnsw') ||
      r.opclass !== (lexical ? 'tsvector_ops' : 'vector_cosine_ops') ||
      (lexical
        ? compact(r.expression ?? '') !== "to_tsvector'english',content_text"
        : r.column !== 'embedding' || r.expression !== null) ||
      compact(r.predicate) !==
        "tenant_idISNULLANDsource_type=ANYARRAY['bill_passage','state_bill_passage']"
    )
      throw Error('EXISTING_BILL_INDEX_REQUIRES_REVIEW');
  }
}
export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({
    args: argv,
    options: { commit: { type: 'boolean' }, 'expected-host': { type: 'string' } },
  });
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const url = new URL(process.env.DATABASE_URL);
  if (args.commit && (!args['expected-host'] || url.hostname !== args['expected-host']))
    throw Error('DATABASE_HOST_MISMATCH');
  // Session settings and concurrent DDL must use the same connection.
  url.searchParams.set('connection_limit', '1');
  const ddl = readFileSync(
    'prisma/migrations/20281101010000_bill_full_text_passage_indexes/migration.sql',
    'utf8',
  )
    .replace(/\r\n/g, '\n')
    .replace(/^--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    ddl.length !== 2 ||
    ddl.some((s, i) => !s.startsWith(`CREATE INDEX IF NOT EXISTS ${names[i]}\n`))
  )
    throw Error('UNEXPECTED_BILL_INDEX_MIGRATION');
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  const inspect = () =>
    db.$queryRawUnsafe<Index[]>(
      `SELECT c.relname name,i.indisvalid valid,i.indisready ready,t.relname "table",m.amname method,
    i.indnkeyatts::int keys,o.opcname opclass,a.attname "column",pg_get_expr(i.indexprs,i.indrelid) expression,pg_get_expr(i.indpred,i.indrelid) predicate
    FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am m ON m.oid=c.relam JOIN pg_opclass o ON o.oid=i.indclass[0]
    LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE n.nspname='public' AND c.relname IN ($1,$2)`,
      ...names,
    );
  try {
    const before = await inspect();
    verifyIndexes(before);
    if (args.commit) {
      await db.$executeRawUnsafe("SET lock_timeout='2s'");
      await db.$executeRawUnsafe("SET statement_timeout='15min'");
      for (const statement of ddl)
        await db.$executeRawUnsafe(
          statement.replace(
            'CREATE INDEX IF NOT EXISTS',
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS',
          ),
        );
      const after = await inspect();
      verifyIndexes(after);
      if (after.length !== 2) throw Error('BILL_INDEX_NOT_VALID');
      console.log(JSON.stringify({ status: 'indexed', indexes: after, ledgerChanged: false }));
    } else
      console.log(
        JSON.stringify({ status: 'dry_run', before, plannedIndexes: names, ledgerChanged: false }),
      );
  } finally {
    await db.$disconnect();
  }
}
/** Exit 0: help/success; 1: invalid configuration or job failure; 2: missing database configuration. */
if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: index-bill-passages [--commit --expected-host host] (requires DATABASE_URL; read-only inspection by default)',
    );
    process.exit(0);
  } else if (!process.env.DATABASE_URL) {
    console.error(
      'Usage: index-bill-passages [--commit --expected-host host] (requires DATABASE_URL)',
    );
    process.exit(2);
  } else {
    void main().catch((e) => {
      console.error(e instanceof Error ? e.message : 'BILL_INDEX_FAILED');
      process.exitCode = 1;
    });
  }
}
