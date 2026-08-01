/**
 * Step 24 — Defense Appropriations public-law (enacted) PE-mark loader.
 *
 *   pnpm --filter @capiro/api parse:defense-approps-public-law -- --artifact scripts/__data__/defense_public_law_fy2027.json
 *
 * Reads a committed rows artifact (offline pdfplumber extraction of the enacted
 * Defense Appropriations public law) and writes each PE's enacted amount to
 * ProgramElementYear.enacted via the program-element writer under source
 * 'public_law_fy<NN>'. The writer validates pe_codes (quarantining bad ones),
 * applies source priority, and emits IntelligenceChange on deltas. Idempotent.
 *
 * DRY RUN by default (PE Watch plan Phase 4): without --commit this prints a
 * diff of the artifact against current enacted values and writes NOTHING.
 * Enacted dollars are the most sensitive field — always inspect the diff.
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
  supersedeSourceDocumentHead,
  sha256OfFile,
  readDocumentToolVersion,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
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
  fy?: number;
  source?: string;
  rows?: ExtractedReportRow[];
  /** R3 §3.3: package-level toplines from the public law's summary tables. */
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
      'Usage: parse-defense-approps-public-law.ts --artifact <rows.json> [--fy 2027] [--inspect | --commit --approved-sha256 <sha>]',
    );
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const fy = Number(arg('fy') ?? artifact.fy);
  if (!Number.isFinite(fy)) {
    console.error('Missing/invalid --fy (and none in artifact)');
    process.exit(1);
  }

  const posture = resolvePeDollarLoaderPosture(process.argv);
  if (posture === 'extract_only') {
    throw new Error(
      'parse-defense-approps-public-law.ts: --extract-only/--dry-run is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const sha256 = sha256OfFile(artifactPath);
  const records = parseExtractedRows(artifact.rows ?? [], { fy });
  const quality = auditArtifactQuality({ rowCount: records.length });

  if (posture === 'inspect') {
    const prisma = new PrismaService();
    await prisma.$connect();
    try {
      const peCodes = [...new Set(records.map((r) => r.peCode))];
      const pes = await prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true },
      });
      const years = await prisma.programElementYear.findMany({
        where: { fy, peCode: { in: peCodes } },
        select: { peCode: true, enacted: true },
      });
      const existing = new Map(
        years.map((y) => [
          y.peCode,
          { currentMillions: y.enacted === null ? null : Number(y.enacted) },
        ]),
      );
      const dlIdx = process.argv.indexOf('--diff-limit');
      const diffLimit = dlIdx >= 0 ? Number(process.argv[dlIdx + 1]) : 15;
      const diff = diffMarks(records, existing, new Set(pes.map((p) => p.peCode)), diffLimit);
      console.log(
        JSON.stringify(
          {
            ...buildInspectReport({
              loader: 'parse-defense-approps-public-law.ts',
              posture,
              artifactPath,
              sha256,
              byteSize: fs.statSync(artifactPath).size,
              quality,
              extra: { stage: 'public_law', fy, rowCount: records.length },
            }),
            diff,
          },
          null,
          2,
        ),
      );
      console.log('INSPECT — no writes. Re-run with --commit --approved-sha256 <sha above> to promote.');
    } finally {
      await prisma.$disconnect();
    }
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
    const parser = new ConferenceReportParserService(writer);
    const source = conferenceReportSource('public_law', fy);

    const reg = await upsertSourceDocument(
      prisma as unknown as SourceDocumentClient,
      {
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        sha256,
        fiscalYear: fy,
        budgetCycle: 'enacted',
        component: null,
        documentType: 'public_law',
        title: 'Defense Appropriations public law (FY' + fy + ')',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        byteSize: fs.statSync(artifactPath).size,
        artifactPath: path.relative(process.cwd(), artifactPath),
        extractionMethod: 'deterministic_pdf',
        extractionToolVersion: readDocumentToolVersion(artifact),
        metadata: { stage: 'public_law', sourceTag: source, approvedSha256: sha256 },
      },
      { deferSupersede: true },
    );

    const result = await parser.load(records, 'public_law', fy, {
      authority: 'enacted_public_law',
      sourceDocumentId: reg.document.id,
      extractorVersion: readDocumentToolVersion(artifact) ?? 'parse-public-law@exact-sha',
    });

    const toplines = await emitToplineCandidates(
      prisma as never,
      artifact.toplines,
      {
        domain: 'defense',
        fiscalYear: fy,
        stage: 'enacted',
        vehicleClass: 'appropriation',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        emittedBy: 'parse-defense-approps-public-law',
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
