import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  upsertSourceDocument,
  supersedeSourceDocumentHead,
  sha256OfFile,
  readDocumentToolVersion,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import { classifyArtifact } from '../src/program-element/source-document/source-document-classify.js';
import {
  assertExactShaCommitAllowed,
  auditArtifactQuality,
  buildInspectReport,
  resolvePeDollarLoaderPosture,
  argValue as exactShaArgValue,
} from './lib/pe-exact-sha-loader-contract.js';
import { isNamedCompanyV1 } from '../src/defense-budget/rdte/r3/r3-named-company-classifier.js';

/**
 * sync-jbook-performers.ts  (Layer 1 — PRIMARY, highest-precision PE -> prime link)
 *
 * Loads named prime contractors ("performing activity") per Program Element from the
 * Service RDT&E Justification Book R-3 "Product Development" / "Support" /
 * "Management Services" cost-analysis tables, with page-level provenance.
 *
 * This is the zero-inference, government-STATED PE -> contractor link: the exhibit
 * names the company, contract method/type, performing location, and total cost. It is
 * the defensible answer for the PE "Top Contractors" panel (vs. the coarse TAS/Program-
 * Activity funding crosswalk, which is a many-to-one overlay handled by enrich-award-pe-tas).
 *
 * Pipeline (mirrors sync-jbook-r2.ts):
 *   1. The deterministic offline extractor scripts/__tools__/extract_jbook_performers.py
 *      (pdfplumber word-coordinate column slicing, $0 — clean text exhibits) is run
 *      against each downloaded RDT&E volume PDF, producing a reviewed JSON artifact
 *      scripts/__data__/jbook_performers_*.json. The service PDFs (Navy/Army/AF/SF) are
 *      WAF/IP-blocked from ECS egress, so they're fetched manually; the loader only
 *      consumes the committed artifact — NO network, NO Python at runtime. Runs anywhere
 *      Node runs, incl. the ECS sync task against Aurora.
 *   2. For each performer row whose PE already exists in program_element (R-2 enriches
 *      known PEs only — a missing PE is reported, not invented), upsert a
 *      program_element_performer row on the natural key, and write a ProgramElementSource
 *      R-3 page citation so the UI can deep-link to the exact exhibit page.
 *
 * Dry-run by default; pass --commit to write. Loads every artifact matching
 * scripts/__data__/jbook_performers_*.json unless --artifact <path> is given.
 */

dotenvConfig();

interface PerformerRow {
  peCode: string;
  peName: string | null;
  projectCode: string | null;
  projectName: string | null;
  costCategory: string | null;
  performer: string;
  performerNormalized: string;
  location: string | null;
  contractMethod: string | null;
  totalCost: number | null;
  fy: number;
  page: number;
}

interface PerformerArtifact {
  docType: string;
  exhibitType: string;
  fy: number;
  sourceUrl: string;
  volumeId: string;
  publisher: string;
  pageCount: number;
  performers: PerformerRow[];
  stats: Record<string, number>;
  error?: string;
}

// Real named company vs government-internal / placeholder ('Various', 'TBD', 'MDA',
// 'Government', 'N/A'). We still STORE these (provenance), but flag isNamedCompany=false
// so the read path can surface only real primes by default.
//
// The classifier itself now lives in r3-named-company-classifier.ts (Gap 2
// closeout) so this legacy loader and the Phase 4 R-3 extractor share one
// implementation instead of two that can drift apart.
const isNamedCompany = isNamedCompanyV1;

function tableTypeFor(costCategory: string | null): string {
  const c = (costCategory || '').toLowerCase();
  if (c.includes('management')) return 'management_services';
  if (c.includes('support')) return 'support';
  return 'product_development';
}

function findArtifacts(): string[] {
  const dir = path.resolve('scripts/__data__');
  const explicit = argValue('--artifact');
  if (explicit) return [path.resolve(explicit)];
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^jbook_performers_.*\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main() {
  const posture = resolvePeDollarLoaderPosture(process.argv);
  if (posture === 'extract_only') {
    throw new Error(
      'sync-jbook-performers.ts: --extract-only is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const commit = posture === 'commit';
  const artifacts = findArtifacts();

  const stats = {
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    artifacts: artifacts.length,
    performer_rows_seen: 0,
    performers_upserted: 0,
    named_company_rows: 0,
    citations_written: 0,
    pe_missing: 0,
    distinct_pes_touched: 0,
    source_documents_inserted: 0,
    source_documents_deduped: 0,
    missing_pe_codes: [] as string[],
  };

  if (artifacts.length === 0) {
    console.log(
      JSON.stringify({ ...stats, note: 'no jbook_performers_*.json artifacts found' }, null, 2),
    );
    return;
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  if (!commit) {
    const reports = [] as Record<string, unknown>[];
    for (const file of artifacts) {
      const sha = sha256OfFile(file);
      const art = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        programElements?: unknown[];
        performers?: unknown[];
        rows?: unknown[];
      };
      const rows = art.programElements?.length ?? art.performers?.length ?? art.rows?.length ?? 1;
      reports.push(
        buildInspectReport({
          loader: 'sync-jbook-performers.ts',
          posture: 'inspect',
          artifactPath: file,
          sha256: sha,
          byteSize: fs.statSync(file).size,
          quality: auditArtifactQuality({ rowCount: Number(rows) || 1 }),
        }),
      );
    }
    console.log(JSON.stringify({ mode: 'INSPECT', artifacts: reports }, null, 2));
    console.log(
      'INSPECT — no writes. Re-run with --commit --approved-sha256 <sha> and a single --artifact.',
    );
    return;
  }
  if (artifacts.length !== 1) {
    throw new Error(
      '--commit for sync-jbook-performers.ts requires exactly one --artifact so one --approved-sha256 can authorize it; got ' +
        String(artifacts.length),
    );
  }

  const touchedPes = new Set<string>();
  const pendingSupersedes: Array<{ prev: string; next: string }> = [];

  try {
    // Validate PEs against program_element once (known set).
    const known = new Set(
      (await prisma.programElement.findMany({ select: { peCode: true } })).map((p) =>
        p.peCode.toUpperCase(),
      ),
    );

    for (const file of artifacts) {
      const art = JSON.parse(fs.readFileSync(file, 'utf-8')) as PerformerArtifact;
      if (art.error) throw new Error(`artifact ${file} has error: ${art.error}`);
      const { sourceUrl: url, fy, publisher } = art;

      // Register the fingerprinted R-3 source document for this volume; stamp its id on the
      // performer rows + citations we write from it.
      let sourceDocumentId: string | null = null;
      if (commit) {
        const cls = classifyArtifact(path.basename(file), { fy });
        const __artSha = sha256OfFile(file);
        assertExactShaCommitAllowed({
          actualSha256: __artSha,
          approvedSha256Raw: exactShaArgValue(process.argv, 'approved-sha256'),
          quality: {
            rowCount: Array.isArray((art as { performers?: unknown[] }).performers)
              ? ((art as { performers?: unknown[] }).performers as unknown[]).length
              : 1,
          },
        });
        const reg = await upsertSourceDocument(
          prisma as unknown as SourceDocumentClient,
          {
            sourceKey: cls?.sourceKey ?? path.basename(file).replace(/\.json$/i, ''),
            sha256: __artSha,
            fiscalYear: cls?.fiscalYear ?? fy ?? null,
            budgetCycle: cls?.budgetCycle ?? 'pb',
            component: cls?.component ?? null,
            documentType: cls?.documentType ?? 'r3',
            title: cls?.title ?? `RDT&E R-3 performers (${art.volumeId})`,
            sourceUrl: url,
            pageCount: art.pageCount ?? null,
            byteSize: fs.statSync(file).size,
            artifactPath: path.relative(process.cwd(), file),
            extractionMethod: 'deterministic_pdf',
            extractionToolVersion: readDocumentToolVersion(art),
            metadata: {
              volumeId: art.volumeId,
              exhibit: art.exhibitType,
              publisher,
              approvedSha256: __artSha,
            },
          },
          { deferSupersede: true },
        );
        sourceDocumentId = reg.document.id;
        if (reg.supersededDocument) {
          pendingSupersedes.push({ prev: reg.supersededDocument.id, next: reg.document.id });
        }
        if (reg.created) stats.source_documents_inserted++;
        else stats.source_documents_deduped++;
      }

      for (const row of art.performers) {
        stats.performer_rows_seen++;
        const named = isNamedCompany(row.performer);
        if (named) stats.named_company_rows++;

        if (!known.has(row.peCode.toUpperCase())) {
          stats.pe_missing++;
          if (stats.missing_pe_codes.length < 50) stats.missing_pe_codes.push(row.peCode);
          continue;
        }
        touchedPes.add(row.peCode.toUpperCase());

        if (!commit) {
          stats.performers_upserted++;
          stats.citations_written++;
          continue;
        }

        // Upsert the performer on the natural key. costCategory may be null -> coalesce
        // to '' in the unique tuple via a sentinel so the unique index behaves (Postgres
        // treats NULLs as distinct; we store '' to keep upsert idempotent).
        await prisma.programElementPerformer.upsert({
          where: {
            peCode_performerNormalized_location_contractMethod_costCategory_fy: {
              peCode: row.peCode,
              performerNormalized: row.performerNormalized,
              location: row.location ?? '',
              contractMethod: row.contractMethod ?? '',
              costCategory: row.costCategory ?? '',
              fy: row.fy,
            },
          } as never,
          create: {
            peCode: row.peCode,
            performer: row.performer,
            performerNormalized: row.performerNormalized,
            location: row.location ?? '',
            contractMethod: row.contractMethod ?? '',
            costCategory: row.costCategory ?? '',
            totalCostM: row.totalCost ?? undefined,
            tableType: tableTypeFor(row.costCategory),
            projectCode: row.projectCode ?? undefined,
            projectName: row.projectName ?? undefined,
            fy: row.fy,
            sourceUrl: url,
            pageNumber: row.page,
            publisher,
            isNamedCompany: named,
            source: 'comptroller_jbook_r3',
            confidence: named ? 0.95 : 0.6,
            sourceDocumentId: sourceDocumentId ?? undefined,
          },
          update: {
            performer: row.performer,
            totalCostM: row.totalCost ?? undefined,
            tableType: tableTypeFor(row.costCategory),
            projectName: row.projectName ?? undefined,
            sourceUrl: url,
            pageNumber: row.page,
            publisher,
            isNamedCompany: named,
            lastSyncedAt: new Date(),
            sourceDocumentId: sourceDocumentId ?? undefined,
          },
        });
        stats.performers_upserted++;

        // R-3 page citation (idempotent on peCode+docType+url+page).
        await prisma.programElementSource.upsert({
          where: {
            peCode_docType_sourceUrl_pageNumber: {
              peCode: row.peCode,
              docType: 'R',
              sourceUrl: url,
              pageNumber: row.page,
            },
          } as never,
          create: {
            peCode: row.peCode,
            docType: 'R',
            exhibitType: 'R-3',
            fy,
            sourceUrl: url,
            pageNumber: row.page,
            snippet: `R-3 Product Development: ${row.performer}${row.location ? ` (${row.location})` : ''}${row.contractMethod ? ` — ${row.contractMethod}` : ''}`,
            publisher: publisher || 'DoD Comptroller',
            confidence: 0.95,
            metadata: { exhibit: 'R-3', performer: row.performer, page: row.page },
            sourceDocumentId: sourceDocumentId ?? undefined,
          },
          update: {
            exhibitType: 'R-3',
            snippet: `R-3 Product Development: ${row.performer}${row.location ? ` (${row.location})` : ''}${row.contractMethod ? ` — ${row.contractMethod}` : ''}`,
            sourceDocumentId: sourceDocumentId ?? undefined,
          },
        });
        stats.citations_written++;
      }
    }

    stats.distinct_pes_touched = touchedPes.size;
    for (const s of pendingSupersedes) {
      await supersedeSourceDocumentHead(prisma as unknown as SourceDocumentClient, s.prev, s.next);
    }
    // Bind the element so noUncheckedIndexedAccess sees the narrowing;
    // artifacts[0] is string|undefined even behind a length check.
    const soleArtifact = artifacts.length === 1 ? artifacts[0] : undefined;
    console.log(
      JSON.stringify(
        {
          ...stats,
          sha256: soleArtifact ? sha256OfFile(soleArtifact) : undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error('[sync-jbook-performers] fatal', e?.stack || e);
  process.exit(1);
});
