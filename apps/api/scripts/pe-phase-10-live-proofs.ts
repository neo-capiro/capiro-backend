/**
 * Phase 10 sole-live (capiro-dev / Aurora) acceptance proofs.
 *
 * Runs INSIDE the API container (ECS one-shot) so DB_* secrets stay in-task.
 * Never pulls Secrets Manager GetSecretValue from the laptop harness.
 *
 * Units (always, no Neo widen):
 *  - inspect-only PE dollar loaders (static contract + one package inspect against live DB)
 *  - register pe10_phase10_internal_promotion source_document then exact-SHA internal promotion
 *  - identical second commit: zero new canonical rows (id-set equality), not mere count equality
 *  - derive-chain dry run (no --commit) under live DATABASE_URL
 *  - live Aurora dual-tenant RLS / ethical wall on program_element_watch (seed+cleanup)
 *  - pre/post non-pe10 mutation boundary (fail on drift)
 *
 * Cleanup: always deletes pe10_closeout / FY2099 package + synthetic pe10 RLS tenants/users.
 * Marks all synthetic loud markers as SYNTHETIC — never humanReviewed.
 *
 * Usage (container entrypoint):
 *   entrypoint.sh pe-phase-10-live-proofs
 *   # or
 *   tsx scripts/pe-phase-10-live-proofs.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PE_EXACT_SHA_DOLLAR_LOADERS } from './lib/pe-exact-sha-loader-contract.js';
import { upsertSourceDocument } from '../src/program-element/source-document/source-document-registry.js';

const DOMAIN = 'pe10_closeout';
const FY = 2099;
const SOURCE_KEY = 'pe10_phase10_internal_promotion';
const PE_CODE = '0603270A'; // common demo PE used for FK-safe checks when present

export interface Pe10LiveProofStep {
  id: string;
  ok: boolean;
  exitCode: number;
  detail: string;
  metrics?: Record<string, number | string | boolean | null>;
}

export interface Pe10LiveProofReport {
  ok: boolean;
  marker: 'PE_PHASE_10_LIVE_PROOFS_OK' | 'PE_PHASE_10_LIVE_PROOFS_FAIL';
  generatedAt: string;
  gitSha: string | null;
  domain: string;
  fiscalYear: number;
  steps: Pe10LiveProofStep[];
  notes: string[];
}

/** Exported for unit locks — never put literal "***" into DATABASE_URL. */
export function ensureDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
  const hasParts = required.every((k) => !!env[k]);
  if (hasParts) {
    const user = env.DB_USER!;
    const pass = encodeURIComponent(env.DB_PASSWORD!);
    const host = env.DB_HOST!;
    const port = env.DB_PORT!;
    const name = env.DB_NAME!;
    // Concatenate segments — never embed a masked "***" marker as the password.
    const auth = user + ':' + pass;
    const url =
      'postgresql://' + auth + '@' + host + ':' + port + '/' + name +
      '?schema=public&sslmode=require&connection_limit=5';
    const maskedMarker = ':' + '*' + '*' + '*' + '@';
    if (url.includes(maskedMarker) || pass === '*' + '*' + '*') {
      throw new Error('pe-phase-10-live-proofs: refused to build masked DATABASE_URL');
    }
    env.DATABASE_URL = url;
    return url;
  }
  const maskedMarker = ':' + '*' + '*' + '*' + '@';
  if (env.DATABASE_URL && !env.DATABASE_URL.includes(maskedMarker)) {
    return env.DATABASE_URL;
  }
  throw new Error(
    'pe-phase-10-live-proofs: need DB_* parts or a real DATABASE_URL (refusing masked URL)',
  );
}

function sha256OfString(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  if (existsSync(resolve(cwd, 'scripts/load-defense-budget-package.ts'))) return cwd;
  if (existsSync(resolve(cwd, 'apps/api/scripts/load-defense-budget-package.ts'))) {
    return resolve(cwd, 'apps/api');
  }
  return cwd;
}

function scratchDir(): string {
  const candidates = [
    process.env.TMPDIR,
    process.env.TEMP,
    '/dev/shm',
    '/app/tmp',
    '/tmp',
  ].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      const dir = resolve(c, 'pe10-closeout');
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* try next */
    }
  }
  throw new Error('pe-phase-10-live-proofs: no writable scratch dir for promotion artifact');
}

function childEnv(): NodeJS.ProcessEnv {
  // Nested tsx must keep writable TMPDIR and a real DATABASE_URL (never masked).
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
  const maskedMarker = ':' + '*' + '*' + '*' + '@';
  if (env.DATABASE_URL && env.DATABASE_URL.includes(maskedMarker)) {
    delete env.DATABASE_URL;
    ensureDatabaseUrl(env);
  }
  for (const k of ['TMPDIR', 'TMP', 'TEMP'] as const) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function buildPromotionArtifact(): {
  json: string;
  path: string;
  sha256: string;
} {
  const dir = scratchDir();
  const artifact = {
    _provenance: {
      note: 'SYNTHETIC PE Phase 10 internal promotion — isolated domain pe10_closeout FY2099; not human-reviewed; auto-cleaned',
      syntheticFigures: true,
      syntheticTestEvent: true,
      phase: 10,
    },
    domain: DOMAIN,
    fiscalYear: FY,
    name: 'PE10 Closeout Synthetic Package FY2099',
    status: 'open',
    vehicles: [
      {
        key: 'pb',
        track: 'request',
        stage: 'president',
        label: 'PE10 SYNTHETIC FY2099 PB',
        status: 'reported',
        statusAt: '2099-01-15',
        sourceUrl: 'https://example.invalid/pe10-closeout-fy2099',
        sourceKey: SOURCE_KEY,
      },
    ],
    positions: [
      {
        vehicleKey: 'pb',
        fiscalYear: FY,
        vehicleClass: 'request',
        stage: 'president',
        scope: 'core_dod_discretionary',
        amountMillions: 1.0,
        units: 'millions',
        effectiveDate: '2099-01-15',
        sourceUrl: 'https://example.invalid/pe10-closeout-fy2099',
        sourcePage: 1,
        note: 'SYNTHETIC PE10 closeout internal promotion (isolated domain)',
        verificationStatus: 'reviewed',
        sourceKey: SOURCE_KEY,
      },
    ],
  };
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const path = resolve(dir, 'fy2099-package.json');
  writeFileSync(path, json, 'utf8');
  return { json, path, sha256: sha256OfString(json) };
}

function runLoader(args: string[]): { code: number; out: string } {
  const root = apiRoot();
  const script = resolve(root, 'scripts/load-defense-budget-package.ts');
  const tsxCandidates = [
    resolve(root, 'node_modules/.bin/tsx'),
    resolve(root, '../../node_modules/.bin/tsx'),
    'tsx',
  ];
  let bin = 'tsx';
  for (const c of tsxCandidates) {
    if (c === 'tsx' || existsSync(c) || existsSync(`${c}.cmd`)) {
      bin = c;
      break;
    }
  }
  const r = spawnSync(bin, [script, ...args], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runDeriveDry(): { code: number; out: string } {
  const root = apiRoot();
  const script = resolve(root, 'scripts/run-pe-derive-chain.ts');
  const tsx = existsSync(resolve(root, 'node_modules/.bin/tsx'))
    ? resolve(root, 'node_modules/.bin/tsx')
    : existsSync(resolve(root, '../../node_modules/.bin/tsx'))
      ? resolve(root, '../../node_modules/.bin/tsx')
      : 'tsx';
  const argv = process.argv.slice(2).filter((a) => a !== '--commit');
  if (argv.includes('--commit')) {
    return { code: 2, out: 'refusing derive dry-run invocation that retained --commit' };
  }
  const r = spawnSync(tsx, [script], {
    cwd: root,
    env: childEnv(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function cleanupDomain(prisma: PrismaClient): Promise<void> {
  const pkg = await prisma.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain: DOMAIN, fiscalYear: FY } },
    select: { id: true },
  });
  if (pkg) {
    await prisma.fundingPosition.deleteMany({ where: { packageId: pkg.id } });
    await prisma.budgetPackageVehicle.deleteMany({ where: { packageId: pkg.id } });
    await prisma.budgetPackage.delete({ where: { id: pkg.id } });
  }
}

async function cleanupPe10SourceDocs(prisma: PrismaClient): Promise<void> {
  // Only remove synthetic pe10 source docs that are not still referenced.
  const docs = await prisma.sourceDocument.findMany({
    where: { sourceKey: SOURCE_KEY },
    select: { id: true },
  });
  for (const d of docs) {
    const pos = await prisma.fundingPosition.count({ where: { sourceDocumentId: d.id } });
    const veh = await prisma.budgetPackageVehicle.count({ where: { sourceDocumentId: d.id } });
    if (pos === 0 && veh === 0) {
      await prisma.sourceDocument.delete({ where: { id: d.id } }).catch(() => undefined);
    }
  }
}

async function countDomainPositions(prisma: PrismaClient): Promise<number> {
  const pkg = await prisma.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain: DOMAIN, fiscalYear: FY } },
    select: { id: true },
  });
  if (!pkg) return 0;
  return prisma.fundingPosition.count({ where: { packageId: pkg.id } });
}

async function domainPositionIds(prisma: PrismaClient): Promise<string[]> {
  const pkg = await prisma.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain: DOMAIN, fiscalYear: FY } },
    select: { id: true },
  });
  if (!pkg) return [];
  const rows = await prisma.fundingPosition.findMany({
    where: { packageId: pkg.id },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}

interface MutationSnapshot {
  fundingPositionsNonPe10: number;
  budgetPackagesNonPe10: number;
  fundingPositionsGlobal: number;
  defenseFy2026Positions: number | null;
  pe10SourceDocs: number;
}

async function mutationSnapshot(prisma: PrismaClient): Promise<MutationSnapshot> {
  const pe10 = await prisma.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain: DOMAIN, fiscalYear: FY } },
    select: { id: true },
  });
  const pe10Id = pe10?.id ?? null;
  const fundingPositionsGlobal = await prisma.fundingPosition.count();
  const fundingPositionsNonPe10 = pe10Id
    ? await prisma.fundingPosition.count({ where: { packageId: { not: pe10Id } } })
    : fundingPositionsGlobal;
  const budgetPackagesNonPe10 = await prisma.budgetPackage.count({
    where: { NOT: { domain: DOMAIN, fiscalYear: FY } },
  });
  const defense = await prisma.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain: 'defense', fiscalYear: 2026 } },
    select: { id: true, _count: { select: { positions: true } } },
  });
  const pe10SourceDocs = await prisma.sourceDocument.count({ where: { sourceKey: SOURCE_KEY } });
  return {
    fundingPositionsNonPe10,
    budgetPackagesNonPe10,
    fundingPositionsGlobal,
    defenseFy2026Positions: defense?._count.positions ?? null,
    pe10SourceDocs,
  };
}

async function registerPromotionSource(
  prisma: PrismaClient,
  art: { json: string; sha256: string; path: string },
): Promise<{ ok: boolean; detail: string; documentId: string | null }> {
  try {
    const result = await upsertSourceDocument(prisma, {
      sourceKey: SOURCE_KEY,
      sha256: art.sha256,
      fiscalYear: FY,
      budgetCycle: 'pb',
      component: null,
      documentType: 'other',
      title: 'PE10 SYNTHETIC internal promotion artifact (auto-cleaned)',
      sourceUrl: 'https://example.invalid/pe10-closeout-fy2099',
      byteSize: Buffer.byteLength(art.json, 'utf8'),
      artifactPath: art.path,
      extractionMethod: 'manual',
      extractionToolVersion: 'pe-phase-10-live-proofs',
      metadata: {
        synthetic: true,
        syntheticTestEvent: true,
        phase: 10,
        note: 'SYNTHETIC — not humanReviewed; Phase 10 internal promotion only',
      },
    });
    const found = await prisma.sourceDocument.findFirst({
      where: { sourceKey: SOURCE_KEY, supersededByDocumentId: null },
      select: { id: true, sourceKey: true },
    });
    if (!found) {
      return { ok: false, detail: 'source_document missing after upsert', documentId: null };
    }
    return {
      ok: true,
      detail: `registered source_key=${SOURCE_KEY} id=${found.id} created=${result.created}`,
      documentId: found.id,
    };
  } catch (e) {
    return {
      ok: false,
      detail: `upsertSourceDocument failed: ${(e as Error).message.slice(0, 400)}`,
      documentId: null,
    };
  }
}

async function proveRls(prisma: PrismaClient): Promise<Pe10LiveProofStep> {
  const notes: string[] = [];
  const peExists = await prisma.programElement.findUnique({
    where: { peCode: PE_CODE },
    select: { peCode: true },
  });
  if (!peExists) {
    return {
      id: 'rls_ethical_wall',
      ok: false,
      exitCode: 1,
      detail: `PE ${PE_CODE} missing on live plane — cannot prove watch RLS without PE FK`,
    };
  }

  const policies: Array<{ policyname: string; cmd: string; qual: string | null }> =
    await prisma.$queryRawUnsafe(
      `SELECT policyname, cmd, qual::text AS qual
       FROM pg_policies
       WHERE tablename = 'program_element_watch'`,
    );
  if (!policies.length) {
    return {
      id: 'rls_ethical_wall',
      ok: false,
      exitCode: 1,
      detail: 'no RLS policies on program_element_watch',
    };
  }
  notes.push(`policies=${policies.map((p) => p.policyname).join(',')}`);

  const force: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> =
    await prisma.$queryRawUnsafe(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'program_element_watch' AND n.nspname = current_schema()`,
    );
  if (!force[0]?.relrowsecurity || !force[0]?.relforcerowsecurity) {
    return {
      id: 'rls_ethical_wall',
      ok: false,
      exitCode: 1,
      detail: `RLS not forced: ${JSON.stringify(force[0] ?? null)}`,
    };
  }

  // Seed two synthetic tenants + users + watches under pe10 domain.
  // Critical: set_config bypass MUST be inside the same transaction as creates
  // (session GUC is local to the tx on FORCE RLS tables like tenants).
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const slugA = `pe10-rls-a-${suffix}`;
  const slugB = `pe10-rls-b-${suffix}`;
  const emailA = `pe10-rls-a-${suffix}@example.invalid`;
  const emailB = `pe10-rls-b-${suffix}@example.invalid`;
  const clerkA = `pe10_clerk_a_${suffix}`;
  const clerkB = `pe10_clerk_b_${suffix}`;
  let tenantAId: string | null = null;
  let tenantBId: string | null = null;
  let userAId: string | null = null;
  let userBId: string | null = null;
  let watchAId: string | null = null;
  let watchBId: string | null = null;

  try {
    const seeded = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const tA = await tx.tenant.create({
        data: {
          slug: slugA,
          name: `PE10 RLS A ${suffix}`,
          status: 'pending',
          settings: { synthetic: true, phase: 10, pe10: true },
        },
        select: { id: true },
      });
      const tB = await tx.tenant.create({
        data: {
          slug: slugB,
          name: `PE10 RLS B ${suffix}`,
          status: 'pending',
          settings: { synthetic: true, phase: 10, pe10: true },
        },
        select: { id: true },
      });
      const uA = await tx.user.create({
        data: { clerkUserId: clerkA, email: emailA, firstName: 'PE10', lastName: 'RLS-A' },
        select: { id: true },
      });
      const uB = await tx.user.create({
        data: { clerkUserId: clerkB, email: emailB, firstName: 'PE10', lastName: 'RLS-B' },
        select: { id: true },
      });
      const wA = await tx.programElementWatch.create({
        data: { tenantId: tA.id, userId: uA.id, peCode: PE_CODE },
        select: { id: true },
      });
      const wB = await tx.programElementWatch.create({
        data: { tenantId: tB.id, userId: uB.id, peCode: PE_CODE },
        select: { id: true },
      });
      return {
        tA: tA.id,
        tB: tB.id,
        uA: uA.id,
        uB: uB.id,
        wA: wA.id,
        wB: wB.id,
      };
    });
    tenantAId = seeded.tA;
    tenantBId = seeded.tB;
    userAId = seeded.uA;
    userBId = seeded.uB;
    watchAId = seeded.wA;
    watchBId = seeded.wB;

    // Fail-closed probe in its own short transaction (bypass off).
    let bare = -1;
    let failClosedError = false;
    try {
      bare = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '', true)`);
        const bareRows: Array<{ c: bigint | number }> = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::bigint AS c FROM program_element_watch WHERE id IN ('${watchAId}'::uuid, '${watchBId}'::uuid)`,
        );
        return Number(bareRows[0]?.c ?? -1);
      });
    } catch {
      failClosedError = true;
      bare = 0;
    }

    // Tenant A sees own, not other — UUID constants only (seeded above).
    const { ownN, leakN } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', '${tenantAId}', true)`,
      );
      const seeOwn: Array<{ c: bigint | number }> = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS c FROM program_element_watch WHERE id = '${watchAId}'::uuid`,
      );
      const seeOther: Array<{ c: bigint | number }> = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS c FROM program_element_watch WHERE id = '${watchBId}'::uuid`,
      );
      return {
        ownN: Number(seeOwn[0]?.c ?? 0),
        leakN: Number(seeOther[0]?.c ?? 0),
      };
    });

    const bypassN = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const bypassRows: Array<{ c: bigint | number }> = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS c FROM program_element_watch WHERE id IN ('${watchAId}'::uuid, '${watchBId}'::uuid)`,
      );
      return Number(bypassRows[0]?.c ?? 0);
    });

    const failClosedOk = failClosedError || bare === 0;
    const dualTenantOk = ownN === 1 && leakN === 0 && bypassN === 2;
    const ok = failClosedOk && dualTenantOk && force[0].relforcerowsecurity;

    return {
      id: 'rls_ethical_wall',
      ok,
      exitCode: ok ? 0 : 1,
      detail: ok
        ? `live Aurora dual-tenant RLS PASS: force=true policies=${policies.length} bareProbe=${bare} failClosedError=${failClosedError} own=${ownN} leak=${leakN} bypass=${bypassN}; seeded tenants ${slugA}/${slugB}`
        : `RLS dual-tenant FAIL bare=${bare} own=${ownN} leak=${leakN} bypass=${bypassN} failClosedError=${failClosedError}`,
      metrics: {
        bare,
        ownN,
        leakN,
        bypassN,
        policies: policies.length,
        dualTenantSeeded: true,
        failClosedError,
        crossTenantOk: leakN === 0,
      },
    };
  } catch (e) {
    return {
      id: 'rls_ethical_wall',
      ok: false,
      exitCode: 1,
      detail: `RLS dual-tenant seed/probe error: ${(e as Error).message.slice(0, 800)}; ${notes.join('; ')}`,
    };
  } finally {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        if (watchAId) await tx.programElementWatch.deleteMany({ where: { id: watchAId } });
        if (watchBId) await tx.programElementWatch.deleteMany({ where: { id: watchBId } });
        if (userAId) await tx.user.deleteMany({ where: { id: userAId } });
        if (userBId) await tx.user.deleteMany({ where: { id: userBId } });
        if (tenantAId) await tx.tenant.deleteMany({ where: { id: tenantAId } });
        if (tenantBId) await tx.tenant.deleteMany({ where: { id: tenantBId } });
        await tx.tenant.deleteMany({ where: { slug: { in: [slugA, slugB] } } });
        await tx.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
      });
    } catch {
      /* best effort cleanup */
    }
  }
}

async function main(): Promise<void> {
  ensureDatabaseUrl();
  const report: Pe10LiveProofReport = {
    ok: false,
    marker: 'PE_PHASE_10_LIVE_PROOFS_FAIL',
    generatedAt: new Date().toISOString(),
    gitSha: process.env.GIT_SHA ?? process.env.PE_CLOSEOUT_HEAD_SHA ?? null,
    domain: DOMAIN,
    fiscalYear: FY,
    steps: [],
    notes: [
      'SYNTHETIC domain pe10_closeout FY2099 only — not humanReviewed',
      'No Secrets Manager GetSecretValue',
      'No email / LlamaParse / derive --commit',
      'Disposable rls-phase-c-pass.txt is NOT evidence',
    ],
  };

  // 1) Static exact-SHA loaders (inspect-only contract)
  {
    const root = apiRoot();
    const verifier = resolve(root, 'scripts/verify-pe-phase-e-exact-sha.ts');
    const tsx = existsSync(resolve(root, 'node_modules/.bin/tsx'))
      ? resolve(root, 'node_modules/.bin/tsx')
      : 'tsx';
    const r = spawnSync(tsx, [verifier], {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      shell: false,
    });
    report.steps.push({
      id: 'inspect_only_loaders_static',
      ok: r.status === 0,
      exitCode: r.status ?? 1,
      detail: (r.stdout || r.stderr || '').slice(-500) || `checked ${PE_EXACT_SHA_DOLLAR_LOADERS.length}`,
    });
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await cleanupDomain(prisma);
    await cleanupPe10SourceDocs(prisma);

    const art = buildPromotionArtifact();
    const preSnap = await mutationSnapshot(prisma);

    // 2) Inspect-only package load against live DB (no --commit)
    const inspect = runLoader(['--artifact', art.path]);
    const inspectOk =
      inspect.code === 0 &&
      /INSPECT|Dry run|DRY RUN|positions:/i.test(inspect.out) &&
      !/COMMIT\s/i.test(inspect.out.split('\n')[0] ?? '');
    report.steps.push({
      id: 'inspect_only_loaders',
      ok: inspectOk && inspect.code === 0,
      exitCode: inspectOk ? 0 : inspect.code || 1,
      detail: inspect.out.slice(-700),
      metrics: { artifactSha256: art.sha256 },
    });

    // 2b) Fail-closed source registration BEFORE promotion
    const reg = await registerPromotionSource(prisma, art);
    report.steps.push({
      id: 'source_document_register',
      ok: reg.ok && !!reg.documentId,
      exitCode: reg.ok && reg.documentId ? 0 : 1,
      detail: reg.detail,
      metrics: { sourceKey: SOURCE_KEY, documentId: reg.documentId },
    });
    if (!reg.ok || !reg.documentId) {
      // Cannot promote without registered source — fail closed early but still run derive/rls if possible
      report.steps.push({
        id: 'exact_sha_internal_promotion',
        ok: false,
        exitCode: 1,
        detail: 'SKIPPED: pe10_phase10_internal_promotion source_document missing/unregistered — fail closed',
      });
      report.steps.push({
        id: 'identical_replay',
        ok: false,
        exitCode: 1,
        detail: 'SKIPPED: promotion blocked by missing source registration',
      });
    } else {
      const preGlobal = await prisma.fundingPosition.count();
      const preDomain = await countDomainPositions(prisma);

      // 3) Exact-SHA internal promotion (commit #1)
      const commit1 = runLoader([
        '--artifact',
        art.path,
        '--commit',
        '--approved-sha256',
        art.sha256,
      ]);
      const missingSource = /MISSING SOURCE/i.test(commit1.out);
      const post1Domain = await countDomainPositions(prisma);
      const post1Global = await prisma.fundingPosition.count();
      const ids1 = await domainPositionIds(prisma);
      const linked = await prisma.fundingPosition.count({
        where: {
          packageId: (
            await prisma.budgetPackage.findUnique({
              where: { domain_fiscalYear: { domain: DOMAIN, fiscalYear: FY } },
              select: { id: true },
            })
          )?.id,
          sourceDocumentId: reg.documentId,
        },
      });
      const promoOk =
        commit1.code === 0 &&
        !missingSource &&
        post1Domain >= 1 &&
        ids1.length === post1Domain &&
        linked >= 1 &&
        post1Global >= preGlobal + (post1Domain - preDomain);
      report.steps.push({
        id: 'exact_sha_internal_promotion',
        ok: promoOk,
        exitCode: promoOk ? 0 : commit1.code || 1,
        detail: `commit1 exit=${commit1.code} missingSource=${missingSource} domainPositions=${post1Domain} linkedSource=${linked} globalΔ=${post1Global - preGlobal} sha=${art.sha256}\n${commit1.out.slice(-600)}`,
        metrics: {
          preGlobal,
          post1Global,
          preDomain,
          post1Domain,
          linkedSourceRows: linked,
          missingSource,
          sha256: art.sha256,
          idCount: ids1.length,
        },
      });

      // 4) Identical replay (commit #2) — zero NEW canonical rows (id-set equality)
      const commit2 = runLoader([
        '--artifact',
        art.path,
        '--commit',
        '--approved-sha256',
        art.sha256,
      ]);
      const post2Domain = await countDomainPositions(prisma);
      const post2Global = await prisma.fundingPosition.count();
      const ids2 = await domainPositionIds(prisma);
      const idSetEqual =
        ids1.length === ids2.length && ids1.every((id, i) => id === ids2[i]);
      const insertClaim = /positions:\s*insert=(\d+)/i.exec(commit2.out);
      const insertN = insertClaim ? Number(insertClaim[1]) : null;
      const newRows = post2Domain - post1Domain;
      const replayOk =
        commit2.code === 0 &&
        !/MISSING SOURCE/i.test(commit2.out) &&
        post2Domain === post1Domain &&
        post2Global === post1Global &&
        idSetEqual &&
        newRows === 0 &&
        (insertN === null || insertN === 0);
      report.steps.push({
        id: 'identical_replay',
        ok: replayOk,
        exitCode: replayOk ? 0 : commit2.code || 1,
        detail: `commit2 exit=${commit2.code} domain ${post1Domain}→${post2Domain} global ${post1Global}→${post2Global} idSetEqual=${idSetEqual} insertN=${insertN} newRows=${newRows}\n${commit2.out.slice(-600)}`,
        metrics: {
          post1Domain,
          post2Domain,
          post1Global,
          post2Global,
          duplicateWrites: newRows,
          idSetEqual,
          insertN,
          newCanonicalRows: newRows,
        },
      });
    }

    // 5) Derive-chain dry run under live config
    const der = runDeriveDry();
    const hasDryMarker = /\[pe-derive-chain\]\s+dry run complete/i.test(der.out);
    const commitMode =
      /"mode"\s*:\s*"COMMIT"/i.test(der.out) || /\bmode=COMMIT\b/i.test(der.out);
    const wroteSync =
      /SyncRun row written/i.test(der.out) && !/no SyncRun row written/i.test(der.out);
    const emailsSent = /"emails_sent"\s*:\s*([1-9]\d*)/i.exec(der.out);
    const emailSentN = emailsSent ? Number(emailsSent[1]) : 0;
    const derOk =
      der.code === 0 && hasDryMarker && !commitMode && !wroteSync && emailSentN === 0;
    report.steps.push({
      id: 'derive_chain_dry_run',
      ok: derOk,
      exitCode: derOk ? 0 : der.code || 1,
      detail: der.out.slice(-900),
      metrics: {
        hasDryMarker,
        commitMode,
        wroteSync,
        emailSentN,
        exit: der.code,
      },
    });

    // 6) RLS ethical wall — dual-tenant seed on live Aurora
    const rls = await proveRls(prisma);
    report.steps.push(rls);

    // 7) Mutation boundary: non-pe10 counts must not drift vs pre-snapshot
    const midSnap = await mutationSnapshot(prisma);
    const nonPe10Drift =
      midSnap.fundingPositionsNonPe10 !== preSnap.fundingPositionsNonPe10 ||
      midSnap.budgetPackagesNonPe10 !== preSnap.budgetPackagesNonPe10 ||
      midSnap.defenseFy2026Positions !== preSnap.defenseFy2026Positions;
    report.steps.push({
      id: 'mutation_boundary_observe',
      ok: !nonPe10Drift,
      exitCode: nonPe10Drift ? 1 : 0,
      detail: nonPe10Drift
        ? `NON-PE10 DRIFT detected pre=${JSON.stringify(preSnap)} mid=${JSON.stringify(midSnap)}`
        : `non-pe10 stable pre/mid; defenseFy2026=${midSnap.defenseFy2026Positions}; pe10SourceDocs=${midSnap.pe10SourceDocs}`,
      metrics: {
        preNonPe10Positions: preSnap.fundingPositionsNonPe10,
        midNonPe10Positions: midSnap.fundingPositionsNonPe10,
        preDefenseFy2026: preSnap.defenseFy2026Positions,
        midDefenseFy2026: midSnap.defenseFy2026Positions,
        prePackagesNonPe10: preSnap.budgetPackagesNonPe10,
        midPackagesNonPe10: midSnap.budgetPackagesNonPe10,
        drift: nonPe10Drift,
      },
    });

    // cleanup synthetic domain + source docs
    await cleanupDomain(prisma);
    await cleanupPe10SourceDocs(prisma);
    const afterClean = await countDomainPositions(prisma);
    const postSnap = await mutationSnapshot(prisma);
    const cleanupBoundaryOk =
      afterClean === 0 &&
      postSnap.fundingPositionsNonPe10 === preSnap.fundingPositionsNonPe10 &&
      postSnap.budgetPackagesNonPe10 === preSnap.budgetPackagesNonPe10 &&
      postSnap.defenseFy2026Positions === preSnap.defenseFy2026Positions;
    report.steps.push({
      id: 'synthetic_cleanup',
      ok: cleanupBoundaryOk,
      exitCode: cleanupBoundaryOk ? 0 : 1,
      detail: `pe10_closeout FY2099 posts cleanup positions=${afterClean}; nonPe10 stable=${cleanupBoundaryOk}`,
      metrics: {
        afterClean,
        postNonPe10: postSnap.fundingPositionsNonPe10,
        preNonPe10: preSnap.fundingPositionsNonPe10,
      },
    });
  } finally {
    try {
      await cleanupDomain(prisma);
      await cleanupPe10SourceDocs(prisma);
    } catch {
      /* best effort */
    }
    await prisma.$disconnect();
  }

  report.ok = report.steps.every((s) => s.ok);
  report.marker = report.ok ? 'PE_PHASE_10_LIVE_PROOFS_OK' : 'PE_PHASE_10_LIVE_PROOFS_FAIL';
  // Full report first (ship parser prefers steps+metrics JSON over SUMMARY-only).
  console.log(JSON.stringify(report));
  // Compact trailer with per-step ok + metrics for CloudWatch tail recovery.
  const compact: Record<string, unknown> = {
    marker: report.marker,
    ok: report.ok,
    gitSha: report.gitSha,
    generatedAt: report.generatedAt,
    steps: report.steps.map((s) => ({
      id: s.id,
      ok: s.ok,
      exitCode: s.exitCode,
      metrics: s.metrics ?? null,
      detail: (s.detail || '').slice(0, 240),
    })),
  };
  console.log(`PE_PHASE_10_LIVE_PROOFS_SUMMARY ${JSON.stringify(compact)}`);
  console.log(report.marker);
  if (!report.ok) process.exit(1);
}

void main().catch((e) => {
  console.error('[pe-phase-10-live-proofs] fatal', (e as Error)?.stack ?? e);
  process.exit(1);
});
