/**
 * Migration drift check — "is the schema this code needs actually there?"
 *
 * This exists because of F0 (2026-07-27). Gate E was merged, its image built,
 * deployed, and digest-verified — and LegiWatch Recommendations still returned
 * HTTP 500 for every tenant, because the two migrations the new code depended
 * on were never applied. A green ECS digest proves the right *image* is
 * running. It does not prove the schema that image needs exists.
 *
 * Usage
 *   # offline: compare the repo against a captured _prisma_migrations dump
 *   tsx apps/api/scripts/verify-migrations.ts --applied=dump.json
 *
 *   # live: run the read-only diag task against capiro-dev and compare
 *   tsx apps/api/scripts/verify-migrations.ts --live
 *
 *   # scope to one service tree
 *   tsx apps/api/scripts/verify-migrations.ts --live --service=intel-api
 *
 * Exits non-zero on drift. Exits 0 and prints a per-service table otherwise.
 *
 * ---------------------------------------------------------------------------
 * Three facts about this repo drive the comparison semantics. Each was verified
 * live against capiro-dev on 2026-07-27; getting any of them wrong produces a
 * check that cries wolf, and a check that cries wolf gets ignored.
 *
 * 1. ALL FIVE SERVICE TREES SHARE ONE DATABASE, HENCE ONE _prisma_migrations.
 *    api, intel-api, api-strategy, onboard-api and workspace every one resolve
 *    DB_NAME='capiro' against the same Aurora cluster (infra/cdk/lib/data-stack.ts:43
 *    sets databaseName='capiro'; compute-stack.ts:515,916,1040,1183 pass it to
 *    each task def; apps/intel-api/scripts/entrypoint.sh:70 says so in prose).
 *    So the comparison is ONE-DIRECTIONAL PER TREE: every repo migration must
 *    appear in the table. It is NOT set equality — the table legitimately holds
 *    every other tree's migrations, plus at least one name whose directory no
 *    longer exists in any tree (20260524010000_add_program_element, superseded by
 *    20260528085651_add_program_element). Extra rows are not drift.
 *
 * 2. A ROLLED-BACK ROW IS NOT, BY ITSELF, DRIFT.
 *    Both entrypoints auto-resolve stuck migrations before deploying: they set
 *    rolled_back_at = NOW() on any unfinished row so a failed attempt cannot
 *    block forward progress (apps/api/scripts/entrypoint.sh,
 *    apps/intel-api/scripts/entrypoint.sh:38-61). Prisma then re-applies and
 *    writes a NEW row. The result is that a perfectly healthy migration can have
 *    several rolled-back rows plus one successful one — 20 such rows exist in
 *    capiro-dev right now, across 10 distinct names (kg_views alone has 5).
 *    Every one of those 10 also has a successful row, so a literal
 *    "rolled_back_at IS NOT NULL ⇒ fail" rule would report 10 false failures.
 *    A name is APPLIED iff at least one row has finished_at IS NOT NULL AND
 *    rolled_back_at IS NULL. A name whose rows are ALL rolled back or unfinished
 *    is genuinely drifted, and is reported as such.
 *
 * 3. MIGRATION DIRECTORY NAMES ARE NOT UNIQUE BY TIMESTAMP.
 *    apps/api carries two directories stamped 20260804010000
 *    (engagement_artifact_lifecycle and engagement_attachment_supersede).
 *    Prisma keys on the full directory name, so this is fine — but never key a
 *    check on the timestamp prefix.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One row of the target database's `_prisma_migrations` table. */
export interface AppliedRow {
  migration_name: string;
  finished_at: string | null;
  rolled_back_at: string | null;
}

/** A repo migration that the target database cannot satisfy. */
export interface MissingMigration {
  name: string;
  /**
   * `absent` — no row at all: the migration was never run.
   * `never-succeeded` — rows exist but every one is rolled back or unfinished.
   */
  reason: 'absent' | 'never-succeeded';
}

export interface ServiceDrift {
  service: string;
  repoCount: number;
  appliedCount: number;
  missing: MissingMigration[];
}

export interface Options {
  live: boolean;
  appliedFile: string | null;
  service: string | null;
  cluster: string;
  taskDefinition: string;
  container: string;
  logGroup: string;
  logStreamPrefix: string;
  subnets: string;
  securityGroups: string;
  profile: string | null;
  region: string;
}

const DEFAULTS: Options = {
  live: false,
  appliedFile: null,
  service: null,
  cluster: 'capiro-dev',
  // The read-only inspector. NOT a *-migrate task def: this check must never be
  // able to mutate the schema it is auditing, and the permission classifier
  // blocks run-task against the migrate families anyway.
  taskDefinition: 'capiro-dev-api-diag',
  container: 'db-inspect',
  logGroup: '/capiro/dev/api',
  logStreamPrefix: 'diag',
  subnets: 'subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19',
  securityGroups: 'sg-01def4e5c0fe44d4a',
  profile: null,
  region: 'us-east-1',
};

export function parseArgs(argv: string[]): Options {
  const o: Options = { ...DEFAULTS };
  for (const arg of argv.slice(2)) {
    if (arg === '--live') o.live = true;
    else if (arg.startsWith('--applied=')) o.appliedFile = arg.slice('--applied='.length) || null;
    else if (arg.startsWith('--service=')) o.service = arg.slice('--service='.length) || null;
    else if (arg.startsWith('--cluster=')) o.cluster = arg.slice('--cluster='.length);
    else if (arg.startsWith('--task-definition=')) o.taskDefinition = arg.slice('--task-definition='.length);
    else if (arg.startsWith('--container=')) o.container = arg.slice('--container='.length);
    else if (arg.startsWith('--log-group=')) o.logGroup = arg.slice('--log-group='.length);
    else if (arg.startsWith('--subnets=')) o.subnets = arg.slice('--subnets='.length);
    else if (arg.startsWith('--security-groups=')) o.securityGroups = arg.slice('--security-groups='.length);
    else if (arg.startsWith('--profile=')) o.profile = arg.slice('--profile='.length) || null;
    else if (arg.startsWith('--region=')) o.region = arg.slice('--region='.length);
  }
  return o;
}

/**
 * The set of migration names the target database can actually satisfy.
 * See header note 2: at least one row must have finished and not been rolled back.
 */
export function successfulNames(rows: AppliedRow[]): Set<string> {
  const ok = new Set<string>();
  for (const r of rows) {
    if (r.finished_at !== null && r.finished_at !== undefined && (r.rolled_back_at === null || r.rolled_back_at === undefined)) {
      ok.add(r.migration_name);
    }
  }
  return ok;
}

/** Every migration name present in the table in any state, successful or not. */
export function allNames(rows: AppliedRow[]): Set<string> {
  return new Set(rows.map((r) => r.migration_name));
}

/**
 * Group `apps/<service>/prisma/migrations/<name>/migration.sql` paths by service.
 * Accepts both forward and backslash separators so it works on Windows.
 */
export function groupRepoMigrations(files: string[]): Map<string, string[]> {
  const byService = new Map<string, string[]>();
  for (const raw of files) {
    const file = raw.trim();
    if (!file) continue;
    const parts = file.replace(/\\/g, '/').split('/');
    // apps / <service> / prisma / migrations / <name> / migration.sql
    const service = parts[1];
    const name = parts[4];
    if (parts.length < 6 || !service || !name) continue;
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service)!.push(name);
  }
  for (const list of byService.values()) list.sort();
  return byService;
}

export function computeDrift(repo: Map<string, string[]>, rows: AppliedRow[]): ServiceDrift[] {
  const ok = successfulNames(rows);
  const seen = allNames(rows);
  const out: ServiceDrift[] = [];
  for (const service of [...repo.keys()].sort()) {
    const names = repo.get(service)!;
    const missing: MissingMigration[] = names
      .filter((n) => !ok.has(n))
      .map((n) => ({ name: n, reason: seen.has(n) ? ('never-succeeded' as const) : ('absent' as const) }));
    out.push({ service, repoCount: names.length, appliedCount: names.length - missing.length, missing });
  }
  return out;
}

export function hasDrift(reports: ServiceDrift[]): boolean {
  return reports.some((r) => r.missing.length > 0);
}

export function formatReport(reports: ServiceDrift[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    const flag = r.missing.length === 0 ? 'OK  ' : 'DRIFT';
    lines.push(`${flag} ${r.service.padEnd(14)} repo=${String(r.repoCount).padStart(3)} applied=${String(r.appliedCount).padStart(3)} missing=${r.missing.length}`);
    for (const m of r.missing) {
      const why =
        m.reason === 'absent'
          ? 'never run against this database'
          : 'rows exist but every one is rolled back or unfinished';
      lines.push(`        !! ${m.name} — ${why}`);
    }
  }
  const total = reports.reduce((n, r) => n + r.missing.length, 0);
  lines.push(
    total === 0
      ? `\nNo drift. Every repo migration across ${reports.length} service tree(s) is applied and not rolled back.`
      : `\n${total} migration(s) missing. The deployed code may reference columns, indexes or tables that do not exist.`,
  );
  return lines.join('\n');
}

/**
 * Strip a UTF-8 BOM. Anything that captures the diag output through a Windows
 * shell (`Out-File -Encoding utf8`) prefixes one, and JSON.parse rejects it with
 * a SyntaxError that prints the entire 36 KB payload as "context".
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** `GATEV_MIGRATIONS_BEGIN` … `GATEV_MIGRATIONS_END` delimited JSON out of the task log. */
export function extractAppliedJson(logText: string): AppliedRow[] {
  const begin = logText.indexOf('GATEV_MIGRATIONS_BEGIN');
  const end = logText.indexOf('GATEV_MIGRATIONS_END');
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('could not find GATEV_MIGRATIONS_BEGIN/END markers in the task log — did the diag task fail?');
  }
  const body = stripBom(logText.slice(begin + 'GATEV_MIGRATIONS_BEGIN'.length, end).trim());
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('expected the diag task to emit a JSON array');
  return parsed as AppliedRow[];
}

// The read-only probe the diag task runs. Composes DATABASE_URL the same way
// every entrypoint does, then dumps the table. No writes, no RLS bypass needed
// (_prisma_migrations carries no RLS policy).
const PROBE_JS = `const { PrismaClient } = require('@prisma/client');
const password = encodeURIComponent(process.env.DB_PASSWORD || '');
process.env.DATABASE_URL = \`postgresql://\${process.env.DB_USER}:\${password}@\${process.env.DB_HOST}:\${process.env.DB_PORT}/\${process.env.DB_NAME}?schema=public&sslmode=require\`;
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
  console.log('GATEV_MIGRATIONS_BEGIN');
  console.log(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  console.log('GATEV_MIGRATIONS_END');
  await prisma.$disconnect();
})().catch((e) => { console.error('GATEV_ERR', e.message); process.exit(1); });
`;

function aws(o: Options, args: string[]): string {
  const full = [...args, '--region', o.region];
  if (o.profile) full.push('--profile', o.profile);
  return execFileSync('aws', full, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Windows resolves `aws` through a shim; POSIX CI does not need a shell.
    shell: process.platform === 'win32',
  });
}

/** Run the read-only diag task and return the parsed `_prisma_migrations` dump. */
export function fetchAppliedLive(o: Options): AppliedRow[] {
  const dir = mkdtempSync(join(tmpdir(), 'verify-migrations-'));
  try {
    const overridesPath = join(dir, 'overrides.json');
    writeFileSync(
      overridesPath,
      JSON.stringify({ containerOverrides: [{ name: o.container, command: [PROBE_JS] }] }),
    );
    const runOut = aws(o, [
      'ecs',
      'run-task',
      '--cluster',
      o.cluster,
      '--task-definition',
      o.taskDefinition,
      '--launch-type',
      'FARGATE',
      '--network-configuration',
      `awsvpcConfiguration={subnets=[${o.subnets}],securityGroups=[${o.securityGroups}],assignPublicIp=DISABLED}`,
      '--overrides',
      `file://${overridesPath.replace(/\\/g, '/')}`,
      '--output',
      'json',
    ]);
    const taskArn: string | undefined = JSON.parse(runOut)?.tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error(`run-task returned no taskArn: ${runOut.slice(0, 500)}`);
    const taskId = taskArn.split('/').pop()!;
    process.stderr.write(`waiting on diag task ${taskId}…\n`);

    aws(o, ['ecs', 'wait', 'tasks-stopped', '--cluster', o.cluster, '--tasks', taskId]);

    const desc = JSON.parse(
      aws(o, ['ecs', 'describe-tasks', '--cluster', o.cluster, '--tasks', taskId, '--output', 'json']),
    );
    const exitCode = desc?.tasks?.[0]?.containers?.[0]?.exitCode;
    if (exitCode !== 0) {
      throw new Error(`diag task exited ${exitCode} (${desc?.tasks?.[0]?.stoppedReason ?? 'no reason given'})`);
    }

    const logs = JSON.parse(
      aws(o, [
        'logs',
        'get-log-events',
        '--log-group-name',
        o.logGroup,
        '--log-stream-name',
        `${o.logStreamPrefix}/${o.container}/${taskId}`,
        '--start-from-head',
        '--output',
        'json',
      ]),
    );
    const text = (logs?.events ?? []).map((e: { message: string }) => e.message).join('\n');
    return extractAppliedJson(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function repoMigrationFiles(): string[] {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  const out = execFileSync('git', ['ls-files', 'apps/*/prisma/migrations/*/migration.sql'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return out.split('\n').filter(Boolean);
}

function main(): void {
  const o = parseArgs(process.argv);
  if (!o.live && !o.appliedFile) {
    process.stderr.write('usage: verify-migrations.ts (--live | --applied=<dump.json>) [--service=<name>]\n');
    process.exit(2);
  }

  let repo = groupRepoMigrations(repoMigrationFiles());
  if (o.service) {
    const only = repo.get(o.service);
    if (!only) {
      process.stderr.write(`unknown service tree '${o.service}'. Known: ${[...repo.keys()].sort().join(', ')}\n`);
      process.exit(2);
    }
    repo = new Map([[o.service, only]]);
  }

  const rows = o.live
    ? fetchAppliedLive(o)
    : (JSON.parse(stripBom(readFileSync(o.appliedFile!, 'utf8'))) as AppliedRow[]);

  const reports = computeDrift(repo, rows);
  process.stdout.write(formatReport(reports) + '\n');
  process.exit(hasDrift(reports) ? 1 : 0);
}

// Only run when executed directly, so the spec can import the pure helpers.
if (process.argv[1] && /verify-migrations\.(ts|js)$/.test(process.argv[1])) {
  main();
}
