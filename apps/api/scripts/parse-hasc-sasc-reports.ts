/**
 * Step 22 — HASC / SASC committee-report PE-mark loader.
 *
 *   pnpm --filter @capiro/api parse:hasc-report -- --artifact scripts/__data__/armed_services_hasc_fy2027.json
 *   pnpm --filter @capiro/api parse:sasc-report -- --artifact scripts/__data__/armed_services_sasc_fy2027.json
 *
 * Reads a committed rows artifact produced by the offline pdfplumber extractor
 * (scripts/__tools__/extract_armed_services_report.py) and loads the per-PE
 * committee marks through the program-element writer, which validates pe_codes
 * (quarantining bad ones), applies source priority, and emits IntelligenceChange
 * on deltas. Idempotent: re-running the same artifact yields no new deltas.
 *
 * Consistent with the R-1/R-2 J-book loaders — no Textract/LLM at runtime.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import {
  ArmedServicesReportParserService,
  parseExtractedRows,
  reportSource,
  type Chamber,
  type ExtractedReportRow,
} from '../src/program-element/parsers/armed-services-report-parser.service.js';
import {
  upsertSourceDocument,
  supersedeSourceDocumentHead,
  sha256OfFile,
  readDocumentToolVersion,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import { recordIngestRun, type IngestRunClient } from '../src/program-element/coverage/record-ingest-run.js';
import {
  assertExactShaCommitAllowed,
  auditArtifactQuality,
  buildInspectReport,
  resolvePeDollarLoaderPosture,
  argValue as exactShaArgValue,
} from './lib/pe-exact-sha-loader-contract.js';
import {
  emitToplineCandidates,
  type ArtifactTopline,
} from '../src/budget-packages/topline-candidates.js';

dotenvConfig();

interface Artifact {
  chamber?: string;
  fy?: number;
  source?: string;
  rows?: ExtractedReportRow[];
  /** R3 §3.3: package-level toplines seen on the report's summary page (optional). */
  toplines?: ArtifactTopline[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error(
      'Usage: parse-hasc-sasc-reports.ts --artifact <rows.json> [--chamber HASC|SASC] [--fy 2027] [--inspect | --commit --approved-sha256 <sha>]',
    );
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const chamber = ((arg('chamber') ?? artifact.chamber ?? 'HASC').toUpperCase() as Chamber);
  const fy = Number(arg('fy') ?? artifact.fy);
  if (chamber !== 'HASC' && chamber !== 'SASC') {
    console.error('Invalid chamber: ' + chamber + ' (expected HASC or SASC)');
    process.exit(1);
  }
  if (!Number.isFinite(fy)) {
    console.error('Missing/invalid --fy (and none in artifact)');
    process.exit(1);
  }

  const posture = resolvePeDollarLoaderPosture(process.argv);
  if (posture === 'extract_only') {
    throw new Error(
      'parse-hasc-sasc-reports.ts: --extract-only/--dry-run is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const sha256 = sha256OfFile(artifactPath);
  const records = parseExtractedRows(artifact.rows ?? [], { fy });
  const quality = auditArtifactQuality({ rowCount: records.length });
  if (posture === 'inspect') {
    console.log(
      JSON.stringify(
        buildInspectReport({
          loader: 'parse-hasc-sasc-reports.ts',
          posture,
          artifactPath,
          sha256,
          byteSize: fs.statSync(artifactPath).size,
          quality,
          extra: { chamber, fy, rowCount: records.length },
        }),
        null,
        2,
      ),
    );
    console.log('INSPECT — no writes. Re-run with --commit --approved-sha256 <sha above> to promote.');
    return;
  }
  assertExactShaCommitAllowed({
    actualSha256: sha256,
    approvedSha256Raw: exactShaArgValue(process.argv, 'approved-sha256'),
    quality: { rowCount: records.length },
  });

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const writer = new ProgramElementWriterService(prisma);
    const parser = new ArmedServicesReportParserService(writer);
    const source = reportSource(chamber, fy);

    const reg = await upsertSourceDocument(
      prisma as unknown as SourceDocumentClient,
      {
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        sha256,
        fiscalYear: fy,
        budgetCycle: chamber === 'HASC' ? 'hasc' : 'sasc',
        component: null,
        documentType: 'committee_report',
        title: chamber + ' report marks (FY' + fy + ')',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        byteSize: fs.statSync(artifactPath).size,
        artifactPath: path.relative(process.cwd(), artifactPath),
        extractionMethod: 'deterministic_pdf',
        extractionToolVersion: readDocumentToolVersion(artifact),
        metadata: { chamber, sourceTag: source, approvedSha256: sha256 },
      },
      { deferSupersede: true },
    );

    const result = await parser.load(records, chamber, fy, {
      authority: chamber === 'HASC' ? 'hasc_authorization' : 'sasc_authorization',
      sourceDocumentId: reg.document.id,
      extractorVersion: readDocumentToolVersion(artifact) ?? 'parse-hasc-sasc@exact-sha',
    });

    const ingestRun = await recordIngestRun(prisma as unknown as IngestRunClient, {
      source,
      fy,
      artifactPath: path.relative(process.cwd(), artifactPath),
      artifactSha256: sha256,
      rows: (artifact.rows ?? []).map((r) => ({
        peCode: (r.peCode ?? null) as string | null,
        request: (r.request ?? null) as number | null,
        mark: (r.mark ?? null) as number | null,
        explanation: (r.explanation ?? null) as string | null,
      })),
      outcome: { upserted: result.upserted, changed: result.changed, quarantined: result.quarantined },
      metadata: { chamber, sourceDocumentId: reg.document.id },
    });

    const toplines = await emitToplineCandidates(
      prisma as never,
      artifact.toplines,
      {
        domain: 'defense',
        fiscalYear: fy,
        stage: chamber === 'HASC' ? 'house' : 'senate',
        vehicleClass: 'authorization',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        emittedBy: 'parse-hasc-sasc-reports (' + chamber + ')',
      },
      { commit: true },
    );

    if (reg.supersededDocument) {
      await supersedeSourceDocumentHead(
        prisma as unknown as SourceDocumentClient,
        reg.supersededDocument.id,
        reg.document.id,
      );
    }

    console.log(
      JSON.stringify(
        {
          mode: 'COMMIT',
          artifact: artifactPath,
          sha256,
          ...result,
          ingestRun,
          toplines,
          sourceDocument: {
            id: reg.document.id,
            action: reg.created ? 'inserted' : 'deduped',
            superseded: reg.supersededDocument?.id ?? null,
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
