/** @cleanup-smoke noArgsExit=1 helpExit=0 */
/**
 * sync-report-provisions.ts — Step 2.4 follow-on — load committee-report LANGUAGE
 * provisions (narrative, not dollar tables) + link them to PEs / projects / programs.
 *
 *   pnpm --filter @capiro/api sync:report-provisions                 # DRY RUN (default)
 *   pnpm --filter @capiro/api sync:report-provisions -- --commit     # persist (idempotent)
 *   tsx scripts/sync-report-provisions.ts --commit --dir <path>
 *
 * Reads committee_provisions_<report>_<fy>.json artifacts from a configurable dir
 * (default scripts/__data__/provisions). Each artifact:
 *   { committee, fy, sourceDocumentId?, provisions: [{heading, text, pageStart, pageEnd}] }
 *
 * For each provision it classifies the action (provision-action-classifier), UPSERTs a
 * committee_report_provision row (idempotent on its natural key), and builds
 * provision_pe_link rows (verbatim PE code → accepted; project-title / program-alias →
 * candidate). Idempotent: a re-run with no source changes performs no net new writes.
 *
 * GLOBAL tables (no RLS) — written via raw SQL with app.bypass_rls set. The accuracy
 * logic lives in ProvisionLoader (unit-tested); this script is glue + I/O. main() is
 * guarded so importing the module never auto-runs (the spec imports `run`).
 *
 * DATA-PENDING: the default artifact dir is empty until the (deferred) pdfplumber
 * language-extraction pass produces committee_provisions_*.json; until then a run reads
 * 0 files and writes nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { classifyProvisionAction } from '../src/program-element/provisions/provision-action-classifier.js';
import {
  ProvisionLoader,
  type ProgramAliasRow,
  type ProjectTitleRow,
  type ProvisionArtifact,
  type ProvisionLinkRow,
  type ProvisionLoaderPrisma,
} from '../src/program-element/provisions/provision-loader.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Read `--name value` or `--name=value`. */
function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_DIR = path.resolve(process.cwd(), 'scripts/__data__/provisions');

/** Read every committee_provisions_*.json artifact in a dir (none → []). */
export function readArtifacts(dir: string): ProvisionArtifact[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^committee_provisions_.*\.json$/i.test(f))
    .sort();
  const out: ProvisionArtifact[] = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ProvisionArtifact;
    out.push({
      committee: raw.committee,
      fy: raw.fy,
      sourceDocumentId: raw.sourceDocumentId ?? null,
      provisions: raw.provisions ?? [],
    });
  }
  return out;
}

/**
 * Adapt a live PrismaClient to the loader's narrow port. Raw SQL for the functional-unique
 * upserts (the natural key + link conflict key are COALESCE-based, not Prisma-expressible).
 */
function makePort(prisma: PrismaClient): ProvisionLoaderPrisma {
  return {
    async loadAliases(): Promise<ProgramAliasRow[]> {
      const rows = await prisma.programAlias.findMany({
        select: { programId: true, aliasNormalized: true },
      });
      return rows.map((r) => ({ programId: r.programId, aliasNormalized: r.aliasNormalized }));
    },
    async loadProjectTitles(): Promise<ProjectTitleRow[]> {
      const rows = await prisma.programElementProject.findMany({
        select: { peCode: true, projectCode: true, title: true },
      });
      return rows.map((r) => ({ peCode: r.peCode, projectCode: r.projectCode, title: r.title }));
    },
    async filterExistingPeCodes(candidates: string[]): Promise<string[]> {
      if (candidates.length === 0) return [];
      const rows = await prisma.programElement.findMany({
        where: { peCode: { in: candidates } },
        select: { peCode: true },
      });
      const set = new Set(rows.map((r) => r.peCode));
      return candidates.filter((c) => set.has(c));
    },
    async upsertProvision(input) {
      // Natural key: (COALESCE(source_document_id), committee, fy, heading, COALESCE(page_start)).
      // Postgres has no partial-unique on these columns, so do find-then-write under the
      // bypass-RLS session (the run sets app.bypass_rls). Idempotent UPDATE on re-run.
      const found = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM committee_report_provision
          WHERE COALESCE(source_document_id::text,'') = COALESCE($1::text,'')
            AND committee = $2 AND fy = $3 AND heading = $4
            AND COALESCE(page_start, -1) = COALESCE($5::int, -1)
          LIMIT 1`,
        input.sourceDocumentId,
        input.committee,
        input.fy,
        input.heading,
        input.pageStart,
      );
      if (found[0]) {
        await prisma.$executeRawUnsafe(
          `UPDATE committee_report_provision
              SET text = $2, page_end = $3, action_type = $4, updated_at = now()
            WHERE id = $1::uuid`,
          found[0].id,
          input.text,
          input.pageEnd,
          input.actionType,
        );
        return { id: found[0].id };
      }
      const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO committee_report_provision
           (id, source_document_id, committee, fy, heading, text, page_start, page_end, action_type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, now(), now())
         RETURNING id`,
        input.sourceDocumentId,
        input.committee,
        input.fy,
        input.heading,
        input.text,
        input.pageStart,
        input.pageEnd,
        input.actionType,
      );
      return { id: inserted[0]!.id };
    },
    async insertLinkIfAbsent(link: ProvisionLinkRow): Promise<number> {
      // ON CONFLICT on the functional-unique index
      // (provision_id, COALESCE(pe_code,''), COALESCE(program_id::text,'')) DO NOTHING.
      return prisma.$executeRawUnsafe(
        `INSERT INTO provision_pe_link
           (id, provision_id, pe_code, project_code, program_id, match_basis, confidence, review_status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5, $6, $7, now(), now())
         ON CONFLICT (provision_id, (COALESCE(pe_code, '')), (COALESCE(program_id::text, ''))) DO NOTHING`,
        link.provisionId,
        link.peCode,
        link.projectCode,
        link.programId,
        link.matchBasis,
        link.confidence,
        link.reviewStatus,
      );
    },
  };
}

export async function run(): Promise<{
  mode: string;
  dir: string;
  filesRead: number;
  provisionsUpserted: number;
  linksInsertedByBasis: Record<string, number>;
  linksConsideredByBasis: Record<string, number>;
}> {
  dotenvConfig();
  if (!process.env.DATABASE_URL) {
    throw new Error('Usage: sync-report-provisions requires DATABASE_URL');
  }

  const commit = flag('commit');
  const dir = arg('dir') ?? DEFAULT_DIR;
  const artifacts = readArtifacts(dir);

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    // GLOBAL tables (no RLS), but the connection role still runs under RLS policies for the
    // tenant tables it touches indirectly; bypass so the raw upserts/inserts are unguarded.
    await prisma.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', false)");
    const loader = new ProvisionLoader(makePort(prisma), classifyProvisionAction);
    const summary = await loader.load(artifacts, { commit });
    return {
      mode: commit ? 'COMMIT' : 'DRY_RUN',
      dir,
      filesRead: summary.filesRead,
      provisionsUpserted: summary.provisionsUpserted,
      linksInsertedByBasis: summary.linksInsertedByBasis,
      linksConsideredByBasis: summary.linksConsideredByBasis,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const usage = 'Usage: tsx scripts/sync-report-provisions.ts [--dir <path>] [--commit]';
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(usage);
    return;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--commit') continue;
    if (option === '--dir' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      index += 1;
      continue;
    }
    if (
      option.startsWith('--dir=') &&
      option.slice('--dir='.length) &&
      !option.slice('--dir='.length).startsWith('--')
    )
      continue;
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const summary = await run();
  console.log(JSON.stringify(summary, null, 2));
}

// Guard against auto-running on import (so the spec can import `run`/`readArtifacts` with no
// side effects). process.argv[1] is the entrypoint path only when invoked directly via tsx/node.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /sync-report-provisions(\.[cm]?[jt]s)?$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  void main().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('Usage:')) console.error(message);
    else console.error('[sync-report-provisions] fatal', (e as Error)?.stack || e);
    process.exit(1);
  });
}
