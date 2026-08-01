import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { r2PeSnippet, r2aProjectSnippet } from '../src/program-element/jbook/jbook-extract.js';
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

/**
 * sync-jbook-r2.ts
 *
 * Loads Service RDT&E Justification Book R-2 / R-2A descriptive-summary data
 * (PE-level mission narrative + project list) into the DB, with page-level
 * provenance, from a committed extraction artifact.
 *
 * Pipeline:
 *   1. The deterministic extractor scripts/__tools__/extract_jbook_r2.py
 *      (pdfplumber, $0 — these exhibits are clean text) is run offline against
 *      each downloaded volume PDF, producing a reviewed JSON artifact under
 *      scripts/__data__/jbook_r2_*.json. (asafm.army.mil is WAF/IP-blocked from
 *      our egress, so the PDFs are fetched manually; the loader only consumes
 *      the artifact — no network, runs anywhere Node runs incl. ECS/Aurora.)
 *   2. For each PE in the artifact:
 *        - enrich the EXISTING program_element row (description = mission) —
 *          R-2 only enriches PEs already known from R-1; it never creates
 *          orphan PEs, so a missing PE is reported, not invented.
 *        - write a ProgramElementSource citation per exhibit page (R-2 page
 *          range -> one row at pageStart; deep link `${url}#page=N`).
 *        - upsert each project into program_element_project (R-2A) with its own
 *          mission + page citation.
 *
 * Dry-run by default; pass --commit to write. Loads every artifact matching
 * scripts/__data__/jbook_r2_*.json unless --artifact <path> is given.
 */

dotenvConfig();

interface R2Project {
  projectCode: string;
  title: string;
  mission: string;
  page: number;
}

interface R2ProgramElement {
  peCode: string;
  peName: string;
  budgetActivity: string | null;
  appropriation: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  mission: string;
  projects: R2Project[];
}

interface R2Artifact {
  docType: string;
  exhibitType: string;
  fy: number;
  sourceUrl: string;
  volumeId: string;
  pageCount: number;
  programElements: R2ProgramElement[];
  stats: { program_elements: number; projects: number; pages_with_exhibits: number };
  error?: string;
}

function findArtifacts(): string[] {
  const dir = path.resolve('scripts/__data__');
  const explicit = argValue('--artifact');
  if (explicit) return [path.resolve(explicit)];
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^jbook_r2_.*\.json$/.test(f))
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
      'sync-jbook-r2.ts: --extract-only is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const commit = posture === 'commit';
  const artifacts = findArtifacts();

  const stats = {
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    artifacts: artifacts.length,
    pe_enriched: 0,
    pe_missing: 0, // present in R-2 but not in program_element (no R-1 row) — reported, not created
    pe_citations_written: 0,
    projects_upserted: 0,
    project_citations_written: 0,
    source_documents_inserted: 0,
    source_documents_deduped: 0,
    missing_pe_codes: [] as string[],
  };

  if (artifacts.length === 0) {
    console.log(JSON.stringify({ ...stats, note: 'no jbook_r2_*.json artifacts found' }, null, 2));
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
      const rows =
        art.programElements?.length ??
        art.performers?.length ??
        art.rows?.length ??
        1;
      reports.push(
        buildInspectReport({
          loader: 'sync-jbook-r2.ts',
          posture: 'inspect',
          artifactPath: file,
          sha256: sha,
          byteSize: fs.statSync(file).size,
          quality: auditArtifactQuality({ rowCount: Number(rows) || 1 }),
        }),
      );
    }
    console.log(JSON.stringify({ mode: 'INSPECT', artifacts: reports }, null, 2));
    console.log('INSPECT — no writes. Re-run with --commit --approved-sha256 <sha> and a single --artifact.');
    return;
  }
  if (artifacts.length !== 1) {
    throw new Error(
      '--commit for sync-jbook-r2.ts requires exactly one --artifact so one --approved-sha256 can authorize it; got ' +
        String(artifacts.length),
    );
  }


  const pendingSupersedes: Array<{ prev: string; next: string }> = [];
  try {
    for (const file of artifacts) {
      const art = JSON.parse(fs.readFileSync(file, 'utf-8')) as R2Artifact;
      if (art.error) throw new Error(`artifact ${file} has error: ${art.error}`);
      const url = art.sourceUrl;
      const fy = art.fy;

      // Register the fingerprinted source document for this volume; stamp its id on the
      // citations + projects we write from it. One document per artifact (per sourceUrl).
      let sourceDocumentId: string | null = null;
      if (commit) {
        const cls = classifyArtifact(path.basename(file), { fy });
        const __artSha = sha256OfFile(file);
        assertExactShaCommitAllowed({
          actualSha256: __artSha,
          approvedSha256Raw: exactShaArgValue(process.argv, 'approved-sha256'),
          quality: {
            rowCount: Array.isArray((art as { programElements?: unknown[] }).programElements)
              ? ((art as { programElements?: unknown[] }).programElements as unknown[]).length
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
            documentType: cls?.documentType ?? 'r2',
            title: cls?.title ?? `RDT&E R-2/R-2A justification (${art.volumeId})`,
            sourceUrl: url,
            pageCount: art.pageCount ?? null,
            byteSize: fs.statSync(file).size,
            artifactPath: path.relative(process.cwd(), file),
            extractionMethod: 'deterministic_pdf',
            extractionToolVersion: readDocumentToolVersion(art),
            metadata: {
              volumeId: art.volumeId,
              exhibit: art.exhibitType,
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

      for (const pe of art.programElements) {
        const existing = commit
          ? await prisma.programElement.findUnique({ where: { peCode: pe.peCode } })
          : await prisma.programElement.findUnique({ where: { peCode: pe.peCode }, select: { peCode: true } });

        if (!existing) {
          stats.pe_missing++;
          if (stats.missing_pe_codes.length < 50) stats.missing_pe_codes.push(pe.peCode);
          // Still skip writes — R-2 enriches known PEs only.
          continue;
        }

        if (commit) {
          // 1. Enrich PE narrative (only set description if the R-2 mission is
          //    non-empty; don't clobber an existing description with blank).
          if (pe.mission) {
            await prisma.programElement.update({
              where: { peCode: pe.peCode },
              data: { description: pe.mission, lastSyncedAt: new Date() },
            });
          }
          stats.pe_enriched++;

          // 2. PE-level R-2 page citation (one row at the exhibit's first page).
          if (pe.pageStart) {
            await prisma.programElementSource.upsert({
              where: {
                peCode_docType_sourceUrl_pageNumber: {
                  peCode: pe.peCode,
                  docType: 'R',
                  sourceUrl: url,
                  pageNumber: pe.pageStart,
                },
              } as never,
              create: {
                peCode: pe.peCode,
                docType: 'R',
                exhibitType: 'R-2',
                fy,
                sourceUrl: url,
                pageNumber: pe.pageStart,
                pageEnd: pe.pageEnd ?? undefined,
                snippet: r2PeSnippet(pe.peCode, pe.peName, pe.pageStart, pe.pageEnd),
                publisher: 'DoD Comptroller (Army)',
                confidence: 0.9,
                metadata: { volumeId: art.volumeId, exhibit: 'R-2' },
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
              update: {
                pageEnd: pe.pageEnd ?? undefined,
                exhibitType: 'R-2',
                snippet: r2PeSnippet(pe.peCode, pe.peName, pe.pageStart, pe.pageEnd),
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
            });
            stats.pe_citations_written++;
          }

          // 3. Projects (R-2A) — upsert by (peCode, projectCode).
          for (const proj of pe.projects) {
            await prisma.programElementProject.upsert({
              where: {
                peCode_projectCode: { peCode: pe.peCode, projectCode: proj.projectCode },
              } as never,
              create: {
                peCode: pe.peCode,
                projectCode: proj.projectCode,
                title: proj.title,
                mission: proj.mission || null,
                budgetActivity: pe.budgetActivity ?? undefined,
                fy,
                sourceUrl: url,
                pageNumber: proj.page,
                source: 'comptroller_jbook_r2a',
                confidence: 0.9,
                metadata: { volumeId: art.volumeId },
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
              update: {
                title: proj.title,
                mission: proj.mission || null,
                pageNumber: proj.page,
                lastSyncedAt: new Date(),
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
            });
            stats.projects_upserted++;

            // R-2A page citation.
            await prisma.programElementSource.upsert({
              where: {
                peCode_docType_sourceUrl_pageNumber: {
                  peCode: pe.peCode,
                  docType: 'R',
                  sourceUrl: url,
                  pageNumber: proj.page,
                },
              } as never,
              create: {
                peCode: pe.peCode,
                docType: 'R',
                exhibitType: 'R-2A',
                fy,
                sourceUrl: url,
                pageNumber: proj.page,
                snippet: r2aProjectSnippet(pe.peCode, proj.projectCode, proj.title, url, proj.page),
                publisher: 'DoD Comptroller (Army)',
                confidence: 0.9,
                metadata: { volumeId: art.volumeId, exhibit: 'R-2A', projectCode: proj.projectCode },
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
              update: {
                exhibitType: 'R-2A',
                snippet: r2aProjectSnippet(pe.peCode, proj.projectCode, proj.title, url, proj.page),
                sourceDocumentId: sourceDocumentId ?? undefined,
              },
            });
            stats.project_citations_written++;
          }
        } else {
          // dry-run: count what WOULD be written.
          stats.pe_enriched++;
          if (pe.pageStart) stats.pe_citations_written++;
          stats.projects_upserted += pe.projects.length;
          stats.project_citations_written += pe.projects.length;
        }
      }
    }

    for (const s of pendingSupersedes) {
      await supersedeSourceDocumentHead(
        prisma as unknown as SourceDocumentClient,
        s.prev,
        s.next,
      );
    }

    console.log(
      JSON.stringify(
        {
          ...stats,
          sha256: artifacts.length === 1 ? sha256OfFile(artifacts[0]) : undefined,
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
  console.error('[sync-jbook-r2] fatal', e?.stack || e);
  process.exit(1);
});
