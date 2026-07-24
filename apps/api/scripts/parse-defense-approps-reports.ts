/**
 * Step 23 — House / Senate Defense Appropriations subcommittee report PE-mark loader.
 *
 *   pnpm --filter @capiro/api parse:hac-d-report -- --artifact scripts/__data__/defense_approps_hac_d_fy2027.json
 *   pnpm --filter @capiro/api parse:sac-d-report -- --artifact scripts/__data__/defense_approps_sac_d_fy2027.json
 *
 * Reads a committed rows artifact produced by the offline pdfplumber extractor
 * (scripts/__tools__/extract_armed_services_report.py, which is committee-agnostic)
 * and loads the per-PE appropriations marks through the program-element writer,
 * which validates pe_codes (quarantining bad ones), applies source priority, and
 * emits IntelligenceChange on deltas. Idempotent.
 *
 * Same pattern as Step 22 (Armed Services); shares CommitteeReportParserBase.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import {
  DefenseAppropsReportParserService,
  parseExtractedRows,
  appropsReportSource,
  type AppropsChamber,
} from '../src/program-element/parsers/defense-approps-report-parser.service.js';
import type { ExtractedReportRow } from '../src/program-element/parsers/committee-report-parser.js';
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

function normalizeChamber(raw: string): AppropsChamber | null {
  const c = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (c === 'HACD') return 'HAC-D';
  if (c === 'SACD') return 'SAC-D';
  return null;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: parse-defense-approps-reports.ts --artifact <rows.json> [--chamber HAC-D|SAC-D] [--fy 2027]');
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const chamber = normalizeChamber(arg('chamber') ?? artifact.chamber ?? 'HAC-D');
  const fy = Number(arg('fy') ?? artifact.fy);
  if (!chamber) {
    console.error('Invalid chamber (expected HAC-D or SAC-D)');
    process.exit(1);
  }
  if (!Number.isFinite(fy)) {
    console.error('Missing/invalid --fy (and none in artifact)');
    process.exit(1);
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const writer = new ProgramElementWriterService(prisma);
    const parser = new DefenseAppropsReportParserService(writer);

    const records = parseExtractedRows(artifact.rows ?? [], { fy });
    const result = await parser.load(records, chamber, fy);

    const source = appropsReportSource(chamber, fy);
    const reg = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
      sha256: sha256OfFile(artifactPath),
      fiscalYear: fy,
      budgetCycle: chamber === 'HAC-D' ? 'hac_d' : 'sac_d',
      component: null,
      documentType: 'committee_report',
      title: `${chamber} report marks (FY${fy})`,
      sourceUrl: artifact.source ?? path.basename(artifactPath),
      byteSize: fs.statSync(artifactPath).size,
      artifactPath: path.relative(process.cwd(), artifactPath),
      extractionMethod: 'deterministic_pdf',
      extractionToolVersion: readDocumentToolVersion(artifact),
      metadata: { chamber, sourceTag: source },
    });
    // The writer logs rows under both the full tag (logSourceValue, '__row__') and the
    // fy-suffix-stripped tag (reconciliation per-field rows); fy disambiguates the stripped
    // form across fiscal years.
    const stamped = await prisma.programElementYearSourceValue.updateMany({
      where: { fy, source: { in: [source, source.replace(/_fy\d+$/i, '')] } },
      data: { sourceDocumentId: reg.document.id },
    });

    // R3 §3.3 — appropriations track. Same discipline as parse-hasc-sasc-reports:
    // candidates land as 'extracted', ambiguity yields a warning and no row, and
    // dollar writes require --commit.
    const toplines = await emitToplineCandidates(
      prisma as never,
      artifact.toplines,
      {
        domain: 'defense',
        fiscalYear: fy,
        stage: chamber === 'HAC-D' ? 'house' : 'senate',
        vehicleClass: 'appropriation',
        sourceUrl: artifact.source ?? path.basename(artifactPath),
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        emittedBy: `parse-defense-approps-reports (${chamber})`,
      },
      { commit: process.argv.includes('--commit') },
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
