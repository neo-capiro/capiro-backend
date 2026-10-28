/**
 * Solicitation attachment discovery and secure archive (Funding Opportunities
 * P29).
 *
 *   tsx scripts/sync-tango-opportunity-attachments.ts                  # dry run
 *   tsx scripts/sync-tango-opportunity-attachments.ts --discover-only  # metadata, no fetch
 *   tsx scripts/sync-tango-opportunity-attachments.ts --commit --limit=25
 *
 * DRY-RUN BY DEFAULT. A dry run reports the bytes and the object count it WOULD
 * transfer, and writes nothing — locally or to S3.
 *
 * The canonical Tango funding ingestor enumerates provider attachments and
 * stores their metadata and supplied extracted text. This worker archives the
 * original files. It also discovers resourceLinks retained in legacy SAM rows.
 * Provider attachment search is not used for document enumeration.
 *
 * ── Two phases, separately controllable ──────────────────────────────────────
 *
 * DISCOVER writes metadata rows (`status = 'metadata_only'`). ARCHIVE fetches
 * and stores. `--discover-only` runs the first without the second, because
 * discovery is cheap and safe while archiving spends bandwidth and storage —
 * and because seeing the candidate list before fetching anything is how an
 * operator sanity-checks a first run.
 *
 * ── Refused is not retried ───────────────────────────────────────────────────
 *
 * A row that reached `refused` is skipped by every later run. Retrying an SSRF
 * attempt on a schedule is the attack working, slowly. A `failed` row IS
 * retried — see `isRetryableFailure`.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { fundingLockClient } from '../src/external/tango/funding-catalog.db.js';
import { SAM_FILE_URL_PATTERN, samFileUrlAliases } from '../src/external/tango/funding-catalog.mapper.js';
import { CURRENT_FUNDING_ATTACHMENT_SQL, extractArchivedFundingPdfs } from '../src/external/tango/funding-document-text.js';
import {
  DEFAULT_ATTACHMENT_POLICY,
  fetchAndArchiveAttachment,
  type ArchivePort,
  type AttachmentCandidate,
  type AttachmentPolicy,
  type AttachmentTransport,
  type ArchiveOutcome,
} from '../src/funding-opportunities/opportunity-attachment.service.js';

dotenvConfig();

// ── CLI ──────────────────────────────────────────────────────────────────────

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  discoverOnly: boolean;
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const raw = flagValue(argv, 'limit');
  const parsed = raw != null ? Number(raw) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    discoverOnly: hasFlag(argv, 'discover-only'),
    // A DEFAULT cap, unlike every other sync in this program. Those walk
    // metadata; this one moves bytes, and an unbounded first run against a
    // whole catalog is a bandwidth bill nobody approved.
    limit: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5_000) : 50,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoveredLink {
  samOpportunityId: string;
  sourceUrl: string;
  fileName: string | null;
  declaredMimeType: string | null;
  declaredSizeBytes: number | null;
}

export interface DiscoveryResult {
  links: DiscoveredLink[];
  /** Notices whose `raw` carries no `resourceLinks` KEY at all. */
  noLinksField: number;
  /** Notices whose `resourceLinks` is present and empty — a real "none". */
  emptyLinks: number;
  /** Entries that were not usable strings. Counted, never guessed at. */
  malformed: number;
}

/**
 * Pull attachment URLs out of SAM.gov's own stored search payload.
 *
 * `resourceLinks` is documented as an array of strings. Real payloads have also
 * been observed carrying objects, so both shapes are read — but ONLY a `url`
 * key on an object, never a heuristic scan for "the field that looks like a
 * URL". A guessed field is a guess that reads like a fact.
 *
 * `fileName` is NOT derived from the URL's last path segment. SAM.gov's
 * download URLs end in an opaque id, and turning that into a filename would
 * produce `download` or a uuid presented as the document's name.
 */
export function discoverAttachmentLinks(
  rows: ReadonlyArray<{ id: string; raw: unknown }>,
): DiscoveryResult {
  const links: DiscoveredLink[] = [];
  let noLinksField = 0;
  let emptyLinks = 0;
  let malformed = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    const raw = row.raw;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      noLinksField += 1;
      continue;
    }
    const value = (raw as Record<string, unknown>)['resourceLinks'];
    if (value === undefined || value === null) {
      // NOT "this solicitation has no attachments". SAM.gov omits the key for
      // records ingested before it existed.
      noLinksField += 1;
      continue;
    }
    if (!Array.isArray(value)) {
      malformed += 1;
      continue;
    }
    if (value.length === 0) {
      emptyLinks += 1;
      continue;
    }
    for (const entry of value) {
      let url: string | null = null;
      let fileName: string | null = null;
      let mime: string | null = null;
      let size: number | null = null;
      if (typeof entry === 'string') {
        url = entry;
      } else if (entry != null && typeof entry === 'object' && !Array.isArray(entry)) {
        const o = entry as Record<string, unknown>;
        url = typeof o['url'] === 'string' ? (o['url'] as string) : null;
        fileName = typeof o['name'] === 'string' ? (o['name'] as string) : null;
        mime = typeof o['mimeType'] === 'string' ? (o['mimeType'] as string) : null;
        size = typeof o['size'] === 'number' && o['size'] >= 0 ? (o['size'] as number) : null;
      }
      if (url == null || url.trim() === '') {
        malformed += 1;
        continue;
      }
      const key = `${row.id}\u0000${url.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        samOpportunityId: row.id,
        sourceUrl: url.trim(),
        fileName,
        declaredMimeType: mime,
        declaredSizeBytes: size,
      });
    }
  }

  return { links, noLinksField, emptyLinks, malformed };
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface AttachmentSyncDeps {
  /** Notices to look for links on. */
  readOpportunities: (limit: number) => Promise<Array<{ id: string; raw: unknown }>>;
  /** Insert-if-absent. Archival reads its pending candidates separately. */
  upsertMetadata: (links: DiscoveredLink[]) => Promise<AttachmentCandidate[]>;
  /** Rows in `metadata_only` or a RETRYABLE `failed` state. Never `refused`. */
  readFetchable: (limit: number) => Promise<AttachmentCandidate[]>;
  recordOutcome: (id: string, outcome: ArchiveOutcome, candidate: AttachmentCandidate) => Promise<boolean | void>;
  transport: AttachmentTransport;
  archive: ArchivePort;
  bucket: string;
  prefix: string;
  policy?: AttachmentPolicy;
}

export interface AttachmentSyncSummary {
  opportunitiesScanned: number;
  linksDiscovered: number;
  noLinksField: number;
  emptyLinks: number;
  malformedLinks: number;
  attempted: number;
  archived: number;
  deduplicated: number;
  refused: number;
  failed: number;
  superseded: number;
  /** Bytes that WOULD move on a dry run, or did on a real one. */
  bytes: number;
}

export async function runAttachmentSync(
  deps: AttachmentSyncDeps,
  options: { commit: boolean; discoverOnly: boolean; limit: number },
): Promise<AttachmentSyncSummary> {
  const opportunities = await deps.readOpportunities(options.limit);
  const discovery = discoverAttachmentLinks(opportunities);

  const summary: AttachmentSyncSummary = {
    opportunitiesScanned: opportunities.length,
    linksDiscovered: discovery.links.length,
    noLinksField: discovery.noLinksField,
    emptyLinks: discovery.emptyLinks,
    malformedLinks: discovery.malformed,
    attempted: 0,
    archived: 0,
    deduplicated: 0,
    refused: 0,
    failed: 0,
    superseded: 0,
    bytes: 0,
  };

  if (!options.commit) return summary;

  await deps.upsertMetadata(discovery.links);
  if (options.discoverOnly) return summary;

  const fetchable = await deps.readFetchable(options.limit);
  for (const attachment of fetchable) {
    summary.attempted += 1;
    const outcome = await fetchAndArchiveAttachment(attachment, {
      transport: deps.transport,
      archive: deps.archive,
      bucket: deps.bucket,
      prefix: deps.prefix,
      policy: deps.policy ?? DEFAULT_ATTACHMENT_POLICY,
    });
    if (await deps.recordOutcome(attachment.id, outcome, attachment) === false) {
      summary.superseded += 1;
      continue;
    }
    if (outcome.status === 'archived') {
      summary.archived += 1;
      summary.bytes += outcome.observedSizeBytes;
      if (outcome.deduplicated) summary.deduplicated += 1;
    } else if (outcome.status === 'refused') {
      summary.refused += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

// ── Real wiring ──────────────────────────────────────────────────────────────

/**
 * The rows this run considers.
 *
 * Select notices with a usable link that has not been stored yet. Re-reading
 * the newest notices forever starves legacy records behind a fixed limit.
 * Current opportunities precede history; stored attachment rows are the
 * durable progress marker, including refusals and failed downloads.
 *
 * tenant-scope-exempt: `sam_opportunity` is global federal reference data.
 */
export function realReadOpportunities(prisma: PrismaClient): AttachmentSyncDeps['readOpportunities'] {
  return async (limit) =>
    prisma.$queryRawUnsafe<Array<{ id: string; raw: unknown }>>(`SELECT s.id::text,
      jsonb_build_object('resourceLinks',s.raw_jsonb->'resourceLinks') AS raw
      FROM sam_opportunity s WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.raw_jsonb->'resourceLinks')='array'
          THEN s.raw_jsonb->'resourceLinks' ELSE '[]'::jsonb END) entry(value)
        CROSS JOIN LATERAL (SELECT btrim(CASE WHEN jsonb_typeof(entry.value)='string' THEN entry.value#>>'{}'
          WHEN jsonb_typeof(entry.value->'url')='string' THEN entry.value->>'url' END) AS url) link
        WHERE length(link.url)>0 AND NOT EXISTS (SELECT 1 FROM opportunity_attachment a
          WHERE a.sam_opportunity_id=s.id AND a.source_url=ANY(CASE WHEN link.url ~ $2 THEN
            ARRAY[split_part(link.url,'?',1),split_part(link.url,'?',1)||'?&token='] ELSE ARRAY[link.url] END)))
      ORDER BY coalesce(s.active AND (s.response_deadline IS NULL OR s.response_deadline>=now()),false) DESC,
        s.posted_date DESC NULLS LAST,s.id LIMIT $1`, limit, SAM_FILE_URL_PATTERN);
}

export function realUpsertMetadata(prisma: PrismaClient): AttachmentSyncDeps['upsertMetadata'] {
  return async (links) => {
    for (let offset = 0; offset < links.length; offset += 200) {
      const batch = links.slice(offset, offset + 200);
      const existing = await prisma.opportunityAttachment.findMany({
        where: { OR: batch.map(link => ({ samOpportunityId: link.samOpportunityId, sourceUrl: { in: samFileUrlAliases(link.sourceUrl) } })) },
        select: { samOpportunityId: true, sourceUrl: true },
      });
      const known = new Set(existing.flatMap(row => samFileUrlAliases(row.sourceUrl).map(url => `${row.samOpportunityId}\u0000${url}`)));
      // Preserve provider metadata and every existing archive outcome. The
      // unique constraint also handles a concurrent Tango insert of this URL.
      const data = batch.filter(link => {
        if (known.has(`${link.samOpportunityId}\u0000${link.sourceUrl}`)) return false;
        for (const alias of samFileUrlAliases(link.sourceUrl)) known.add(`${link.samOpportunityId}\u0000${alias}`);
        return true;
      }).map(link => ({
          samOpportunityId: link.samOpportunityId,
          sourceUrl: link.sourceUrl,
          fileName: link.fileName,
          declaredMimeType: link.declaredMimeType,
          declaredSizeBytes: link.declaredSizeBytes == null ? null : BigInt(link.declaredSizeBytes),
          status: 'metadata_only',
      }));
      if (data.length) await prisma.opportunityAttachment.createMany({ data, skipDuplicates: true });
    }
    // Archival independently reads pending metadata, including previous runs.
    return [];
  };
}

export function realReadFetchable(prisma: PrismaClient): AttachmentSyncDeps['readFetchable'] {
  return async (limit) => {
    // `refused` is deliberately ABSENT from this predicate. A refusal is a
    // safety decision, and re-attempting it on a schedule is the attack
    // working slowly.
    // Hash in PostgreSQL so a batch never loads thousands of extracted PDF
    // bodies merely to protect publication from a concurrent amendment.
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; sourceUrl: string; fileName: string | null; declaredMimeType: string | null;
      declaredSizeBytes: bigint | null; sourceVersion: string;
    }>>(`SELECT id::text,source_url AS "sourceUrl",file_name AS "fileName",declared_mime_type AS "declaredMimeType",
      declared_size_bytes AS "declaredSizeBytes",encode(sha256(convert_to(provider_data::text,'UTF8')),'hex') AS "sourceVersion"
      FROM opportunity_attachment WHERE status IN ('metadata_only','failed')
      AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '1 day')
      ORDER BY ${CURRENT_FUNDING_ATTACHMENT_SQL} DESC,last_attempt_at ASC NULLS FIRST,first_seen_at,id LIMIT $1`, limit);
    return rows.map((r) => ({
      id: r.id,
      sourceUrl: r.sourceUrl,
      fileName: r.fileName,
      declaredMimeType: r.declaredMimeType,
      declaredSizeBytes: r.declaredSizeBytes == null ? null : Number(r.declaredSizeBytes),
      sourceVersion: r.sourceVersion,
    }));
  };
}

export function realRecordOutcome(prisma: PrismaClient): AttachmentSyncDeps['recordOutcome'] {
  return async (id, outcome, candidate) => prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe<Array<{ source_url: string; source_version: string }>>(
      "SELECT source_url,encode(sha256(convert_to(provider_data::text,'UTF8')),'hex') AS source_version FROM opportunity_attachment WHERE id=$1::uuid FOR UPDATE", id);
    const current = rows[0];
    if (!current || current.source_url !== candidate.sourceUrl || candidate.sourceVersion !== current.source_version) return false;
    const now = new Date();
    if (outcome.status === 'archived') {
      await tx.opportunityAttachment.update({
        where: { id },
        data: {
          status: 'archived',
          contentSha256: outcome.contentSha256,
          observedSizeBytes: BigInt(outcome.observedSizeBytes),
          observedMimeType: outcome.observedMimeType,
          archiveBucket: outcome.archiveBucket,
          archiveKey: outcome.archiveKey,
          archiveVersionId: outcome.archiveVersionId,
          archivedAt: now,
          lastAttemptAt: now,
          // Cleared: a row that succeeded must not still carry the reason a
          // previous attempt failed, or the CHECK would reject it anyway.
          failureReason: null,
          failureDetail: null,
        },
      });
      return true;
    }
    await tx.opportunityAttachment.update({
      where: { id },
      data: {
        status: outcome.status,
        failureReason: outcome.failureReason,
        failureDetail: outcome.failureDetail,
        lastAttemptAt: now,
        // The archive location is cleared on a failure, so a stale bucket/key
        // from an earlier success cannot make a failed row look citable. The
        // unarchived CHECK enforces the same thing at the database.
        archiveBucket: null,
        archiveKey: null,
        archiveVersionId: null,
        archivedAt: null,
      },
    });
    return true;
  });
}

export const ATTACHMENT_USAGE = 'Usage: sync-tango-opportunity-attachments [--commit] [--discover-only] [--limit=N]. Requires DATABASE_URL; archive commits also need OPPORTUNITY_ATTACHMENT_BUCKET and FUNDING_ALLOWED_DB_HOST. Exit 0: bounded pass; 1: failure; 2: missing database configuration.';
async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? '')) { console.log(ATTACHMENT_USAGE); return; }
  if (argv.some(arg => !/^--(?:commit|discover-only|limit=.+)$/.test(arg))) throw new Error(ATTACHMENT_USAGE);
  const args = parseArgs(argv);
  const bucket = (process.env.OPPORTUNITY_ATTACHMENT_BUCKET ?? '').trim();
  if (args.commit && !args.discoverOnly && !bucket) {
    // A dry run and a discover-only run need no bucket. An archiving run does,
    // and failing here beats fetching megabytes with nowhere to put them.
    console.error(
      'FO_ATTACHMENT_SYNC_ERR No OPPORTUNITY_ATTACHMENT_BUCKET configured; refusing to fetch with nowhere to archive.',
    );
    process.exitCode = 1;
    return;
  }

  const lock = fundingLockClient(args.commit);
  const prisma = new PrismaClient();
  try {
    await lock.connect();
    const acquired = await lock.query("SELECT pg_try_advisory_lock(hashtext('capiro:funding-archive')) AS locked");
    if (!acquired.rows[0].locked) { console.log('FUNDING_ARCHIVE_ALREADY_RUNNING'); return; }
    await prisma.$connect();
    let discoveryLocked = false;
    const summary = await runAttachmentSync(
      {
        readOpportunities: async limit => {
          discoveryLocked = (await lock.query("SELECT pg_try_advisory_lock(hashtext('capiro:tango-funding')) AS locked")).rows[0].locked;
          if (!discoveryLocked) { console.log('FUNDING_LEGACY_DISCOVERY_DEFERRED'); return []; }
          return realReadOpportunities(prisma)(limit);
        },
        upsertMetadata: async links => {
          try { return await realUpsertMetadata(prisma)(links); }
          finally {
            // Hold the catalog lock only for metadata discovery. Original-file
            // transfers can run independently after source identities settle.
            if (discoveryLocked) await lock.query("SELECT pg_advisory_unlock(hashtext('capiro:tango-funding'))");
            discoveryLocked = false;
          }
        },
        readFetchable: realReadFetchable(prisma),
        recordOutcome: realRecordOutcome(prisma),
        transport: httpsTransport(),
        archive: await s3Archive(),
        bucket,
        prefix: (process.env.OPPORTUNITY_ATTACHMENT_PREFIX ?? 'opportunity-attachments').trim(),
      },
      { commit: args.commit, discoverOnly: args.discoverOnly, limit: args.limit },
    );
    console.log(`FO_ATTACHMENT_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit })}`);
    if (args.commit && !args.discoverOnly) console.log(JSON.stringify({ event: 'FUNDING_PDF_TEXT',
      ...await extractArchivedFundingPdfs(prisma, bucket, args.limit) }));
  } finally {
    await lock.end();
    await prisma.$disconnect();
  }
}

/**
 * The real transport. Redirects are followed MANUALLY (`redirect: 'manual'`) so
 * every hop reaches `checkHop` — `fetch`'s own follow mode would chase a 302 to
 * the metadata service before any Capiro code saw the target.
 */
function httpsTransport(): AttachmentTransport {
  return {
    async fetch(url, checkHop, maxRedirects) {
      const redirects: string[] = [];
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const response = await globalThis.fetch(current, {
          redirect: 'manual',
          headers: { accept: '*/*' },
          signal: AbortSignal.timeout(60_000),
        });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          const target = new URL(location, current).toString();
          const verdict = checkHop(target);
          if (!verdict.ok) throw new Error(`${verdict.refusal}: ${verdict.detail}`);
          redirects.push(target);
          current = target;
          continue;
        }
        const parts: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              total += part.value.length;
              if (total > DEFAULT_ATTACHMENT_POLICY.maxObservedBytes) {
                await reader.cancel();
                throw new Error('Attachment body exceeds archive size limit');
              }
              parts.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) { buffer.set(part, offset); offset += part.length; }
        const declared = response.headers.get('content-length');
        return {
          finalUrl: current,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: buffer,
          declaredLength: declared == null ? null : Number(declared),
          uncompressedBytes: null,
          redirects,
        };
      }
      throw new Error('too_many_redirects: redirect limit reached');
    },
  };
}

/** Private, encrypted, and the key is the content hash — see `archiveKeyFor`. */
async function s3Archive(): Promise<ArchivePort> {
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return {
    async exists(bucket, key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    async put(input) {
      const out = await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          // Never rendered inline, for any type — see contentDispositionFor.
          ContentDisposition: input.contentDisposition,
          ServerSideEncryption: 'AES256',
          // Bucket policy/block-public-access owns access. No object ACL: this
          // also supports S3 BucketOwnerEnforced buckets, which disable ACLs.
          Metadata: { 'content-sha256': input.contentSha256 },
        }),
      );
      return { versionId: out.VersionId ?? null };
    },
  };
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-opportunity-attachments(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (!process.env.DATABASE_URL && !process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) {
    console.error('Usage: apps/api/scripts/sync-tango-opportunity-attachments.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  void main().catch((error: unknown) => {
    console.error('FO_ATTACHMENT_SYNC_ERR', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main };
