/**
 * Client-logo garbage collection.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `ClientsService.confirmLogoUpload` (clients.service.ts) writes each
 * confirmed logo to a brand-new, content-addressed key
 * (`tenants/{tenantId}/clients/{clientId}/logos/{uuid}.{ext}`, immutable via
 * `IfNoneMatch: '*'`) and then swaps `Client.logoS3Key` to point at it. The
 * superseded key is deliberately NEVER deleted at swap time — the code
 * comment there explains why: a database commit whose acknowledgement was
 * lost could leave the pointer swapped without the caller ever finding out,
 * and an in-flight report export may have already read the old pointer and
 * be about to fetch it. Deleting eagerly could hand either of those a 404.
 * `delete-tenant.ts` compounds the same problem the other direction: a
 * hard-deleted tenant cascades every `Client` row away via `ON DELETE
 * CASCADE`, taking every record of what `logoS3Key` those clients ever had
 * with it, and touches S3 not at all.
 *
 * Both are the right call at write time, and both leave orphaned objects
 * with nothing that ever reclaims them. This job is that reclaimer.
 *
 * ── What counts as reachable ────────────────────────────────────────────────
 *
 * There is exactly one durable reference to a confirmed client-logo object
 * anywhere in this system: the `Client.logoS3Key` column holding the CURRENT
 * pointer. There is no logo history/version table (checked: `schema.prisma`
 * has no such model) and no audit-log row recording past values (checked:
 * `confirmLogoUpload`/the pointer-swap transaction never write `AuditLog`).
 * Report generation (`report-snapshot.service.ts` / `client-logo.reader.ts`
 * in apps/api-strategy) reads that same live pointer, downloads the bytes,
 * and embeds them into the DOCX/PPTX synchronously within one request — it
 * never persists the S3 key anywhere beyond that request. So "reachable"
 * reduces to: does any `Client` row's `logoS3Key` equal this exact key,
 * right now, across every tenant.
 *
 * ── What counts as in scope ─────────────────────────────────────────────────
 *
 * Only objects matching `CONFIRMED_CLIENT_LOGO_KEY_PATTERN` (exported from
 * clients.service.ts, the exact shape `clientLogoKey()` writes) are ever
 * considered. This bucket also holds tenant branding logos
 * (`tenants/{id}/branding/...`), documents (`tenants/{id}/documents/...`),
 * and unconfirmed staging uploads (`tenants/client-logo-uploads/...`, which
 * already has its own 1-day lifecycle rule in assets-stack.ts) — anything
 * that does not match the confirmed-logo shape is skipped, never deleted,
 * regardless of age or reachability.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 *   - DRY RUN BY DEFAULT. `--commit` is required to delete anything.
 *   - `--min-age-days` (default 30): an unreferenced object must be older
 *     than this before it is eligible. Confirmed keys are write-once and
 *     never overwritten in place, so an object's `LastModified` is exactly
 *     when it was confirmed and never changes — this margin exists purely to
 *     outlive the race the code comment above describes (a request reads the
 *     DB pointer moments before this job's own DB snapshot, then fetches the
 *     object moments after), which resolves in milliseconds in practice. 30
 *     days is deliberately generous.
 *   - The assets bucket is versioned (assets-stack.ts) with a 90-day
 *     `ExpireOldVersions` rule. Deleting the current version creates a
 *     delete marker; the bytes themselves survive as a noncurrent version for
 *     90 more days. That is a real recovery window if this job is ever wrong
 *     about something — a second, independent safety net this job does not
 *     rely on as its primary defense, only benefits from.
 *   - Deletions are per-key, one `DeleteObjectCommand` at a time inside its
 *     own try/catch, matching this repo's `prune-*` convention — never a
 *     bulk operation driven by a filter, so one mistake cannot cascade.
 *   - `--max-deletes` (default 1000) caps how many objects one run will
 *     actually delete. A capped run still reports every orphan it found
 *     (`byVerdict`/`scanned`); nothing is silently dropped from the summary,
 *     and the cap is disclosed by name when it is hit. Re-run to continue.
 *   - Idempotent: a second run over the post-GC set deletes nothing, because
 *     deleted keys no longer appear in the bucket listing.
 *
 *   tsx scripts/gc-client-logos.ts                        # dry run
 *   tsx scripts/gc-client-logos.ts --commit                # deletes
 *   tsx scripts/gc-client-logos.ts --commit --min-age-days=60 --max-deletes=200
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients` is FORCE-RLS. This script has no NestJS PrismaService
 * tenant-scope extension and deliberately reads across every tenant (an
 * orphan can belong to any of them), so it runs the one read query inside
 * `withBypass` — same idiom as prune-stale-assistance-recipient-candidates.ts.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { CONFIRMED_CLIENT_LOGO_KEY_PATTERN } from '../src/clients/clients.service.js';

dotenvConfig();

const SOURCE = 'gc-client-logos';
const DEFAULT_MIN_AGE_DAYS = 30;
const DEFAULT_MAX_DELETES = 1000;
const LIST_PAGE_SIZE = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── CLI ─────────────────────────────────────────────────────────────────────

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface ParsedArgs {
  commit: boolean;
  minAgeDays: number;
  maxDeletes: number;
}

/** Unknown flags are ignored, matching the repo's dominant CLI convention. */
export function parseArgs(argv: string[]): ParsedArgs {
  return {
    commit: hasFlag(argv, 'commit'),
    minAgeDays: positiveIntOr(flagValue(argv, 'min-age-days'), DEFAULT_MIN_AGE_DAYS),
    maxDeletes: positiveIntOr(flagValue(argv, 'max-deletes'), DEFAULT_MAX_DELETES),
  };
}

// ── Classification (pure) ────────────────────────────────────────────────────

export interface BucketObject {
  key: string;
  lastModified: Date | null;
}

export type GcVerdict =
  | 'delete_orphaned'
  | 'keep_referenced'
  | 'keep_too_young'
  | 'skip_out_of_scope'
  | 'skip_unknown_age';

export interface Classified {
  key: string;
  verdict: GcVerdict;
  tenantId: string | null;
  clientId: string | null;
}

export function isDeleteVerdict(verdict: GcVerdict): boolean {
  return verdict === 'delete_orphaned';
}

/**
 * Classify one bucket object. Pure function of (object, the full set of
 * currently-referenced logo keys, "now", the age margin) so the whole
 * decision surface is unit-testable without S3 or a database.
 */
export function classifyObject(
  object: BucketObject,
  referencedKeys: ReadonlySet<string>,
  now: Date,
  minAgeDays: number,
): Classified {
  const match = CONFIRMED_CLIENT_LOGO_KEY_PATTERN.exec(object.key);
  if (!match) {
    return { key: object.key, verdict: 'skip_out_of_scope', tenantId: null, clientId: null };
  }
  const tenantId = match[1] ?? null;
  const clientId = match[2] ?? null;

  if (referencedKeys.has(object.key)) {
    return { key: object.key, verdict: 'keep_referenced', tenantId, clientId };
  }

  // S3 always returns LastModified for a listed object; a null here is
  // unreachable in practice, but a missing timestamp must never be treated
  // as "old enough" — fail closed, not open.
  if (!object.lastModified) {
    return { key: object.key, verdict: 'skip_unknown_age', tenantId, clientId };
  }

  const ageMs = now.getTime() - object.lastModified.getTime();
  if (ageMs < minAgeDays * MS_PER_DAY) {
    return { key: object.key, verdict: 'keep_too_young', tenantId, clientId };
  }

  return { key: object.key, verdict: 'delete_orphaned', tenantId, clientId };
}

// ── Prisma surface (narrow, so the spec can supply a fake) ──────────────────

export interface GcPrisma {
  $transaction<T>(fn: (tx: GcPrisma) => Promise<T>): Promise<T>;
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

async function withBypass<T>(prisma: GcPrisma, fn: (tx: GcPrisma) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

/** Every currently-referenced logo key, across every tenant. */
export async function loadReferencedLogoKeys(prisma: GcPrisma): Promise<Set<string>> {
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<{ logoS3Key: string }>`
      SELECT logo_s3_key AS "logoS3Key"
      FROM clients
      WHERE logo_s3_key IS NOT NULL
    `,
  );
  return new Set(rows.map((r) => r.logoS3Key));
}

// ── S3 surface (narrow, so the spec can supply a fake) ───────────────────────

export interface GcS3 {
  listPage(
    continuationToken: string | undefined,
  ): Promise<{ objects: BucketObject[]; nextToken: string | undefined }>;
  deleteObject(key: string): Promise<void>;
}

export class S3GcClient implements GcS3 {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async listPage(
    continuationToken: string | undefined,
  ): Promise<{ objects: BucketObject[]; nextToken: string | undefined }> {
    const page = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        // Broader than the confirmed-logo shape on purpose — S3 prefixes
        // cannot express the `tenants/*/clients/*/logos/*` wildcard this job
        // actually targets. classifyObject() narrows every listed key down
        // to that exact shape; everything else is skipped, never deleted.
        Prefix: 'tenants/',
        MaxKeys: LIST_PAGE_SIZE,
        ContinuationToken: continuationToken,
      }),
    );
    return {
      objects: (page.Contents ?? [])
        .filter((o): o is typeof o & { Key: string } => Boolean(o.Key))
        .map((o) => ({ key: o.Key, lastModified: o.LastModified ?? null })),
      nextToken: page.IsTruncated ? page.NextContinuationToken : undefined,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface GcResult {
  scanned: number;
  inScope: number;
  deleted: number;
  kept: number;
  skipped: number;
  errors: number;
  byVerdict: Record<GcVerdict, number>;
  /** Keys actually deleted (commit) or that WOULD be deleted (dry run). */
  deletedKeys: string[];
  cappedByMaxDeletes: boolean;
}

function emptyByVerdict(): Record<GcVerdict, number> {
  return {
    delete_orphaned: 0,
    keep_referenced: 0,
    keep_too_young: 0,
    skip_out_of_scope: 0,
    skip_unknown_age: 0,
  };
}

export async function gcClientLogos(
  prisma: GcPrisma,
  s3: GcS3,
  options: { commit: boolean; minAgeDays: number; maxDeletes: number; now?: Date },
): Promise<GcResult> {
  const now = options.now ?? new Date();
  const referenced = await loadReferencedLogoKeys(prisma);

  const result: GcResult = {
    scanned: 0,
    inScope: 0,
    deleted: 0,
    kept: 0,
    skipped: 0,
    errors: 0,
    byVerdict: emptyByVerdict(),
    deletedKeys: [],
    cappedByMaxDeletes: false,
  };

  let token: string | undefined;
  do {
    const page = await s3.listPage(token);
    token = page.nextToken;

    for (const object of page.objects) {
      result.scanned += 1;
      const classified = classifyObject(object, referenced, now, options.minAgeDays);
      result.byVerdict[classified.verdict] += 1;

      switch (classified.verdict) {
        case 'skip_out_of_scope':
        case 'skip_unknown_age':
          result.skipped += 1;
          continue;
        case 'keep_referenced':
        case 'keep_too_young':
          result.kept += 1;
          continue;
        case 'delete_orphaned':
          result.inScope += 1;
          break;
      }

      if (result.deletedKeys.length >= options.maxDeletes) {
        result.cappedByMaxDeletes = true;
        continue;
      }

      if (!options.commit) {
        result.deleted += 1;
        result.deletedKeys.push(object.key);
        continue;
      }

      try {
        await s3.deleteObject(object.key);
        result.deleted += 1;
        result.deletedKeys.push(object.key);
      } catch (error) {
        result.errors += 1;
        console.error(
          `[${SOURCE}] failed to delete ${object.key}: ${(error as Error).message}`,
        );
      }
    }
  } while (token);

  return result;
}

// ── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const bucket = process.env.ASSETS_BUCKET?.trim();
  if (!bucket) {
    console.error(`[${SOURCE}] ASSETS_BUCKET is not set; refusing to run.`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const s3 = new S3GcClient(
    new S3Client({
      region: process.env.AWS_REGION_DEFAULT ?? process.env.AWS_REGION ?? 'us-east-1',
    }),
    bucket,
  );

  try {
    const result = await gcClientLogos(prisma as unknown as GcPrisma, s3, {
      commit: parsed.commit,
      minAgeDays: parsed.minAgeDays,
      maxDeletes: parsed.maxDeletes,
    });

    for (const key of result.deletedKeys) {
      console.log(`[${SOURCE}] ${parsed.commit ? 'DELETED' : 'WOULD DELETE'} ${key}`);
    }

    console.log(
      `[${SOURCE}] scanned=${result.scanned} inScope=${result.inScope} deleted=${result.deleted} ` +
        `kept=${result.kept} skipped=${result.skipped} errors=${result.errors} ` +
        `minAgeDays=${parsed.minAgeDays} maxDeletes=${parsed.maxDeletes} ` +
        `verdicts=${JSON.stringify(result.byVerdict)}`,
    );

    if (result.cappedByMaxDeletes) {
      console.log(
        `[${SOURCE}] max-deletes cap (${parsed.maxDeletes}) reached — additional orphaned ` +
          `objects were found but left in place this run. Re-run to continue reclaiming them.`,
      );
    }

    if (!parsed.commit) {
      console.log(
        `[${SOURCE}] DRY RUN — no objects deleted. Would delete ${result.deleted}. Pass --commit to apply.`,
      );
    } else {
      console.log(`[${SOURCE}] DONE — deleted ${result.deleted} object(s).`);
    }

    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, (error as Error).message);
    process.exit(1);
  });
}
