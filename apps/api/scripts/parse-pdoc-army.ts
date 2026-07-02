/**
 * Step 27 — P-Doc (Procurement) PE-mark loader (all Services, parameterized).
 *
 *   pnpm --filter @capiro/api parse:pdoc -- --service ARMY --artifact scripts/__data__/pdoc_army_aircraft_fy2027.json
 *
 * Reads a committed rows artifact (offline pdfplumber extraction, extract_pdoc.py)
 * and loads parent procurement PEs + child line items via PDocParserService:
 *   - parent PE  → program_element (appropriationType='PROC') + program_element_year
 *   - child rows → program_element_procurement_line (hierarchy by pe_code)
 * under source 'p_doc_<service>_fy<NN>'. The writer validates pe_codes
 * (quarantining bad ones), applies source priority, and emits IntelligenceChange
 * on deltas. Idempotent. Deterministic — no Firecrawl/LLM at runtime.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  upsertSourceDocument,
  sha256OfFile,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import {
  PDocParserService,
  parseProcurementPes,
  type ExtractedProcurementPe,
  type ProcurementService,
} from '../src/program-element/parsers/pdoc/pdoc-parser.service.js';

dotenvConfig();

const SERVICES: ProcurementService[] = ['ARMY', 'NAVY', 'AF', 'SF', 'USMC', 'DW', 'DARPA'];

interface Artifact {
  service?: string;
  fy?: number;
  sourceUrl?: string;
  pes?: ExtractedProcurementPe[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: parse-pdoc.ts --artifact <rows.json> [--service ARMY] [--fy 2027]');
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const service = (arg('service') ?? artifact.service ?? '').toUpperCase() as ProcurementService;
  const fy = Number(arg('fy') ?? artifact.fy);
  if (!SERVICES.includes(service)) {
    console.error(`Invalid --service: ${service} (expected one of ${SERVICES.join(', ')})`);
    process.exit(1);
  }
  if (!Number.isFinite(fy)) {
    console.error('Missing/invalid --fy (and none in artifact)');
    process.exit(1);
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const prismaService = prisma;
    const writer = new ProgramElementWriterService(prismaService);
    const parser = new PDocParserService(writer, prismaService);

    const records = parseProcurementPes(artifact.pes ?? [], { fy, service });
    const result = await parser.load(records, service, fy, artifact.sourceUrl);

    // Provenance: register the fingerprinted artifact and stamp this run's
    // year-source-value rows (same pattern as the committee-report loaders), so
    // P-doc rows carry a sourceDocument instead of blank source URLs.
    const sourceTag = `p_doc_${service.toLowerCase()}_fy${String(fy).slice(-2)}`;
    const reg = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
      sha256: sha256OfFile(artifactPath),
      fiscalYear: fy,
      budgetCycle: 'pb',
      component: service,
      documentType: 'procurement_justification',
      title: `${service} FY${fy} procurement (P-doc)`,
      sourceUrl: artifact.sourceUrl || path.basename(artifactPath),
      byteSize: fs.statSync(artifactPath).size,
      artifactPath: path.relative(process.cwd(), artifactPath),
      extractionMethod: 'deterministic_pdf',
      extractionToolVersion: null,
      metadata: { service, sourceTag },
    });
    const stamped = await prisma.programElementYearSourceValue.updateMany({
      where: { source: { in: [sourceTag, sourceTag.replace(/_fy\d+$/i, '')] } },
      data: { sourceDocumentId: reg.document.id },
    });

    console.log(
      JSON.stringify(
        {
          artifact: artifactPath,
          ...result,
          sourceDocument: { id: reg.document.id, stamped_year_source_values: stamped.count },
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
