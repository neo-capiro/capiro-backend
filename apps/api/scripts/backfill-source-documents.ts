/**
 * Step 0.1 — backfill the SourceDocument registry from committed __data__ artifacts and
 * link existing PE provenance rows to it.
 *
 *   pnpm --filter @capiro/api backfill:source-documents            # DRY RUN (default)
 *   pnpm --filter @capiro/api backfill:source-documents -- --commit
 *
 * Phase 1: one SourceDocument per recognized budget artifact (sha256 of the artifact JSON,
 *          versioned + checksum-deduped via upsertSourceDocument).
 * Phase 2: link pre-existing provenance rows:
 *          - program_element_source  → by (sourceUrl, exhibitType→documentType)
 *          - program_element_project → by sourceUrl, expecting documentType r2
 *          - program_element_performer → by sourceUrl, expecting documentType r3
 *          - program_element_year_source_value → by the committee/conference/public-law
 *            `source` tag carried in the document's metadata.
 *
 * Idempotent + additive: re-running creates no new documents (checksum dedup) and only sets
 * source_document_id where it resolves. Prints a reconciliation table (linked/unlinked by
 * table; unlinked groups enumerated with reasons).
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  classifyArtifact,
  type ArtifactMeta,
} from '../src/program-element/source-document/source-document-classify.js';
import {
  upsertSourceDocument,
  sha256OfFile,
  readDocumentToolVersion,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import {
  chooseDocumentForUrlRow,
  type LinkCandidate,
  type UrlRowToLink,
} from '../src/program-element/source-document/source-document-linker.js';
import { readR1UrlFromText } from '../src/program-element/jbook/jbook-extract.js';

dotenvConfig();

const DATA_DIR = path.resolve('scripts/__data__');
const R1_CONFIG = path.resolve('scripts/__config__/comptroller-document-urls.yaml');

interface RegisteredDoc {
  id: string; // real uuid (commit) or "(dry:<sourceKey>)" placeholder
  sourceKey: string;
  documentType: string;
  sourceUrl: string;
  sourceTag: string | null;
  fiscalYear: number | null;
}

function readArtifact(file: string): ArtifactMeta & Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ArtifactMeta & Record<string, unknown>;
  } catch {
    return {};
  }
}

function r1Url(): string | null {
  try {
    return fs.existsSync(R1_CONFIG) ? readR1UrlFromText(fs.readFileSync(R1_CONFIG, 'utf-8')) : null;
  } catch {
    return null;
  }
}

function resolveSourceUrl(
  documentType: string,
  artifact: Record<string, unknown>,
  sourceKey: string,
  topR1Url: string | null,
): string {
  const url = artifact.sourceUrl;
  if (typeof url === 'string' && url) return url;
  if ((documentType === 'r1' || documentType === 'p1') && topR1Url) return topR1Url;
  const src = artifact.source;
  if (typeof src === 'string' && src) return src;
  return sourceKey; // last-resort stable reference (committee docs without a URL)
}

interface UrlTableReport {
  total: number;
  linked: number;
  unlinked: number;
  linked_pct: number;
  unlinked_groups: Array<{ key: string; count: number; reason: string }>;
}

async function linkUrlTable(
  prisma: PrismaClient,
  commit: boolean,
  model: 'programElementSource' | 'programElementProject' | 'programElementPerformer',
  by: string[],
  docsByUrl: Map<string, LinkCandidate[]>,
  toRow: (g: Record<string, unknown>) => UrlRowToLink,
): Promise<UrlTableReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = (prisma as any)[model];
  const groups: Array<Record<string, unknown>> = await delegate.groupBy({ by, _count: { _all: true } });
  let total = 0;
  let linked = 0;
  let unlinked = 0;
  const unlinkedReasons = new Map<string, { count: number; reason: string }>();

  for (const g of groups) {
    const count = Number((g._count as { _all?: number } | undefined)?._all ?? 0);
    total += count;
    const row = toRow(g);
    const cands = row.sourceUrl ? docsByUrl.get(row.sourceUrl) ?? [] : [];
    const decision = chooseDocumentForUrlRow(row, cands);
    if (decision.documentId) {
      if (commit) {
        const where: Record<string, unknown> = {};
        for (const col of by) where[col] = g[col];
        const res = await delegate.updateMany({ where, data: { sourceDocumentId: decision.documentId } });
        linked += Number(res.count ?? 0);
      } else {
        linked += count; // projected
      }
    } else {
      unlinked += count;
      const key = `${row.sourceUrl ?? '∅'} | ${row.exhibitType ?? row.expectedDocumentType ?? ''}`;
      const prev = unlinkedReasons.get(key);
      unlinkedReasons.set(key, { count: (prev?.count ?? 0) + count, reason: decision.reason });
    }
  }

  return {
    total,
    linked,
    unlinked,
    linked_pct: total ? Math.round((linked / total) * 1000) / 10 : 100,
    unlinked_groups: [...unlinkedReasons.entries()].map(([key, v]) => ({ key, ...v })),
  };
}

async function linkYearSourceValues(prisma: PrismaClient, commit: boolean, docs: RegisteredDoc[]) {
  const total = await prisma.programElementYearSourceValue.count();
  let linked = 0;
  const perTag: Array<{ sourceTag: string; documentId: string; count: number }> = [];
  for (const d of docs) {
    if (!d.sourceTag) continue;
    // The writer logs rows under both the full tag and the fy-suffix-stripped tag
    // (reconciliation per-field rows); fy disambiguates the stripped form across years.
    const stripped = d.sourceTag.replace(/_fy\d+$/i, '');
    const tags = stripped === d.sourceTag ? [d.sourceTag] : [d.sourceTag, stripped];
    const where: Record<string, unknown> = { source: { in: tags } };
    if (d.fiscalYear != null) where.fy = d.fiscalYear;
    let count: number;
    if (commit) {
      const res = await prisma.programElementYearSourceValue.updateMany({
        where,
        data: { sourceDocumentId: d.id },
      });
      count = res.count;
    } else {
      count = await prisma.programElementYearSourceValue.count({ where });
    }
    linked += count;
    if (count) perTag.push({ sourceTag: d.sourceTag, documentId: d.id, count });
  }
  return {
    total,
    linked,
    unlinked: total - linked,
    linked_pct: total ? Math.round((linked / total) * 1000) / 10 : 100,
    per_tag: perTag,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/backfill-source-documents.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = process.argv.includes('--commit');
  const prisma = new PrismaClient();
  await prisma.$connect();

  const topR1 = r1Url();
  const files = fs.existsSync(DATA_DIR)
    ? fs
        .readdirSync(DATA_DIR)
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .sort()
    : [];

  const registered: RegisteredDoc[] = [];
  const skipped: string[] = [];
  let inserted = 0;
  let deduped = 0;

  try {
    // ── Phase 1: register one document per recognized budget artifact ──
    for (const f of files) {
      const full = path.join(DATA_DIR, f);
      if (!fs.statSync(full).isFile()) {
        skipped.push(f);
        continue;
      }
      const artifact = readArtifact(full);
      const cls = classifyArtifact(f, artifact);
      if (!cls) {
        skipped.push(f);
        continue;
      }
      const sourceUrl = resolveSourceUrl(cls.documentType, artifact, cls.sourceKey, topR1);
      const pageCount = typeof artifact.pageCount === 'number' ? (artifact.pageCount as number) : null;

      if (commit) {
        const reg = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
          sourceKey: cls.sourceKey,
          sha256: sha256OfFile(full),
          fiscalYear: cls.fiscalYear,
          budgetCycle: cls.budgetCycle,
          component: cls.component,
          documentType: cls.documentType,
          title: cls.title,
          sourceUrl,
          byteSize: fs.statSync(full).size,
          pageCount,
          artifactPath: path.relative(process.cwd(), full),
          extractionMethod: 'deterministic_pdf',
          extractionToolVersion: readDocumentToolVersion(artifact),
          metadata: { sourceTag: cls.sourceTag, component: cls.component, backfilled: true },
        });
        if (reg.created) inserted += 1;
        else deduped += 1;
        registered.push({
          id: reg.document.id,
          sourceKey: cls.sourceKey,
          documentType: cls.documentType,
          sourceUrl,
          sourceTag: cls.sourceTag,
          fiscalYear: cls.fiscalYear,
        });
      } else {
        registered.push({
          id: `(dry:${cls.sourceKey})`,
          sourceKey: cls.sourceKey,
          documentType: cls.documentType,
          sourceUrl,
          sourceTag: cls.sourceTag,
          fiscalYear: cls.fiscalYear,
        });
      }
    }

    // Build the per-URL candidate index for the linker.
    const docsByUrl = new Map<string, LinkCandidate[]>();
    for (const d of registered) {
      const arr = docsByUrl.get(d.sourceUrl) ?? [];
      arr.push({ id: d.id, documentType: d.documentType, sourceUrl: d.sourceUrl });
      docsByUrl.set(d.sourceUrl, arr);
    }

    // ── Phase 2: link existing provenance rows ──
    const linkReport = {
      program_element_source: await linkUrlTable(
        prisma,
        commit,
        'programElementSource',
        ['sourceUrl', 'exhibitType'],
        docsByUrl,
        (g) => ({ sourceUrl: (g.sourceUrl as string | null) ?? null, exhibitType: (g.exhibitType as string | null) ?? null }),
      ),
      program_element_project: await linkUrlTable(
        prisma,
        commit,
        'programElementProject',
        ['sourceUrl'],
        docsByUrl,
        (g) => ({ sourceUrl: (g.sourceUrl as string | null) ?? null, expectedDocumentType: 'r2' }),
      ),
      program_element_performer: await linkUrlTable(
        prisma,
        commit,
        'programElementPerformer',
        ['sourceUrl'],
        docsByUrl,
        (g) => ({ sourceUrl: (g.sourceUrl as string | null) ?? null, expectedDocumentType: 'r3' }),
      ),
      program_element_year_source_value: await linkYearSourceValues(prisma, commit, registered),
    };

    const summary = {
      mode: commit ? 'COMMIT' : 'DRY_RUN',
      artifacts_scanned: files.length,
      artifacts_skipped: skipped.length,
      documents: { registered: registered.length, inserted, deduped },
      link_report: linkReport,
      skipped_examples: skipped.slice(0, 10),
    };
    console.log(JSON.stringify(summary, null, 2));

    // Human-readable reconciliation table on stderr (keeps stdout pure JSON).
    const rows = [
      ['table', 'total', 'linked', 'unlinked', 'linked_%'],
      ...Object.entries(linkReport).map(([t, r]) => [t, r.total, r.linked, r.unlinked, `${r.linked_pct}%`]),
    ];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    console.error(`\n[backfill-source-documents] ${summary.mode} — ${registered.length} documents (${inserted} new, ${deduped} deduped)`);
    for (const r of rows) console.error('  ' + r.map((c, i) => String(c).padEnd(widths[i]!)).join('  '));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[backfill-source-documents] fatal', err?.stack || err);
  process.exit(1);
});
}
