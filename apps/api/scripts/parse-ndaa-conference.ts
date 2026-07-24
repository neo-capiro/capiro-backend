/**
 * Step 24 — NDAA conference report PE-mark loader (final negotiated authorization).
 *
 *   pnpm --filter @capiro/api parse:ndaa-conference -- --artifact scripts/__data__/ndaa_conference_fy2027.json           # DRY RUN diff
 *   pnpm --filter @capiro/api parse:ndaa-conference -- --artifact scripts/__data__/ndaa_conference_fy2027.json --commit  # load
 *
 * Reads a committed rows artifact (offline pdfplumber extraction) and writes each
 * PE's conference mark to ProgramElementYear.ndaaConference (authorization track —
 * kept OUT of the appropriations funding ladder) via the program-element writer
 * under source 'conference_report_fy<NN>'. The writer validates pe_codes
 * (quarantining bad ones), applies source priority, and emits IntelligenceChange
 * on deltas. Idempotent. Same pattern as Steps 22/23.
 *
 * DRY RUN by default (PE Watch plan Phase 4 — dollar loads keep the
 * dry-run → inspect → commit discipline): without --commit this prints a diff
 * of the artifact against current program_element_year values (new / changed /
 * unchanged / missing-PE counts + samples) and writes NOTHING.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import {
  ConferenceReportParserService,
  conferenceReportSource,
  parseExtractedRows,
} from '../src/program-element/parsers/conference-report-parser.service.js';
import type { ExtractedReportRow } from '../src/program-element/parsers/committee-report-parser.js';
import { diffMarks } from '../src/program-element/parsers/mark-dry-run-diff.js';
import {
  upsertSourceDocument,
  sha256OfFile,
  readDocumentToolVersion,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import {
  emitToplineCandidates,
  type ArtifactTopline,
} from '../src/budget-packages/topline-candidates.js';

dotenvConfig();

interface Artifact {
  fy?: number;
  source?: string;
  rows?: ExtractedReportRow[];
  /** R3 §3.3: package-level toplines seen on the conference report's summary page. */
  toplines?: ArtifactTopline[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: parse-ndaa-conference.ts --artifact <rows.json> [--fy 2027]');
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const fy = Number(arg('fy') ?? artifact.fy);
  if (!Number.isFinite(fy)) {
    console.error('Missing/invalid --fy (and none in artifact)');
    process.exit(1);
  }

  const commit = process.argv.includes('--commit');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const writer = new ProgramElementWriterService(prisma);
    const parser = new ConferenceReportParserService(writer);
    const records = parseExtractedRows(artifact.rows ?? [], { fy });

    if (!commit) {
      const peCodes = [...new Set(records.map((r) => r.peCode))];
      const pes = await prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true },
      });
      const years = await prisma.programElementYear.findMany({
        where: { fy, peCode: { in: peCodes } },
        select: { peCode: true, ndaaConference: true },
      });
      const existing = new Map(
        years.map((y) => [
          y.peCode,
          { currentMillions: y.ndaaConference === null ? null : Number(y.ndaaConference) },
        ]),
      );
      const dlIdx = process.argv.indexOf('--diff-limit');
      const diffLimit = dlIdx >= 0 ? Number(process.argv[dlIdx + 1]) : 15;
      const diff = diffMarks(records, existing, new Set(pes.map((p) => p.peCode)), diffLimit);
      console.log(
        JSON.stringify(
          { mode: 'DRY_RUN', stage: 'conference', fy, artifact: artifactPath, diff },
          null,
          2,
        ),
      );
      console.log('DRY RUN — inspect the diff, then re-run with --commit to load.');
      return;
    }

    const result = await parser.load(records, 'conference', fy);

    const source = conferenceReportSource('conference', fy);
    const reg = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
      sha256: sha256OfFile(artifactPath),
      fiscalYear: fy,
      budgetCycle: 'conference',
      component: null,
      documentType: 'conference_report',
      title: `NDAA conference report (FY${fy})`,
      sourceUrl: artifact.source ?? path.basename(artifactPath),
      byteSize: fs.statSync(artifactPath).size,
      artifactPath: path.relative(process.cwd(), artifactPath),
      extractionMethod: 'deterministic_pdf',
      extractionToolVersion: readDocumentToolVersion(artifact),
      metadata: { stage: 'conference', sourceTag: source },
    });
    // The writer logs rows under both the full tag (logSourceValue, '__row__') and the
    // fy-suffix-stripped tag (reconciliation per-field rows); fy disambiguates the stripped
    // form across fiscal years.
    const stamped = await prisma.programElementYearSourceValue.updateMany({
      where: { fy, source: { in: [source, source.replace(/_fy\d+$/i, '')] } },
      data: { sourceDocumentId: reg.document.id },
    });

    // R3 §3.3 — authorization CONFERENCE stage. This block only runs after the
    // --commit gate above, so a dry run never stages a topline either.
    const toplines = await emitToplineCandidates(
      prisma as never,
      artifact.toplines,
      {
        domain: 'defense',
        fiscalYear: fy,
        stage: 'conference',
        vehicleClass: 'authorization',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        emittedBy: 'parse-ndaa-conference',
      },
      { commit: true },
    );

    console.log(
      JSON.stringify(
        {
          artifact: artifactPath,
          ...result,
          toplines,
          sourceDocument: {
            id: reg.document.id,
            action: reg.created ? 'inserted' : 'deduped',
            superseded: reg.supersededDocument?.id ?? null,
            stamped_year_source_values: stamped.count,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
