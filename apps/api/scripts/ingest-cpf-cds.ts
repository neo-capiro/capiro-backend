import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  upsertSourceDocument,
  sha256OfFile,
} from '../src/program-element/source-document/source-document-registry.js';
import { CommunityFundingUpsertService } from '../src/government-data/community-funding/community-funding.upsert.service.js';
import { CommunityFundingDiscoveryService } from '../src/government-data/community-funding/community-funding.discovery.service.js';
import { createDistrictNexusChangeSink } from '../src/district-nexus/priority-intelligence/priority-intelligence-cpf-cds-bridge.js';
import { DistrictNexusChangeWriter } from '../src/district-nexus/priority-intelligence/priority-intelligence-changes.js';
import {
  parseHousePdfRows,
  parseSenatePdfRows,
} from '../src/government-data/community-funding/community-funding.parser.js';
import { readHouseCpfWorkbook } from '../src/government-data/community-funding/community-funding.xlsx.js';
import type {
  Chamber,
  ExtractedFundingRow,
} from '../src/government-data/community-funding/community-funding.types.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const chamber = required('chamber') as Chamber,
      fiscalYear = Number(required('fy'));
    if (!['house', 'senate'].includes(chamber) || !Number.isInteger(fiscalYear))
      throw new Error('invalid --chamber or --fy');
    if (process.argv.includes('--discover')) {
      const result = await new CommunityFundingDiscoveryService(
        prisma as unknown as PrismaService,
      ).discoverAndPersist(chamber, fiscalYear);
      console.log(
        JSON.stringify({ crawlId: result.crawlId, candidates: result.candidates.length }, null, 2),
      );
      return;
    }
    const artifactPath = path.resolve(required('artifact')),
      sourceUrl = required('source-url');
    const sourceFile = path.resolve(arg('source-file') ?? artifactPath);
    const sourceKey = required('source-key'),
      sha256 = sha256OfFile(sourceFile),
      subcommittee = arg('subcommittee') ?? null;
    const prior = await prisma.communityFundingIngestRun.findFirst({
      where: { source: sourceKey, artifactSha256: sha256, status: { in: ['ok', 'warn'] } },
    });
    if (prior && !process.argv.includes('--force')) {
      console.log(JSON.stringify({ skipped: true, reason: 'unchanged artifact', runId: prior.id }));
      return;
    }
    let parsed,
      pageCount: number | null = null,
      documentType: string,
      extractionMethod: string;
    if (artifactPath.toLowerCase().endsWith('.xlsx')) {
      if (chamber !== 'house') throw new Error('XLSX profile is House-only');
      parsed = await readHouseCpfWorkbook(artifactPath, fiscalYear);
      documentType = 'cpf_consolidated_xlsx';
      extractionMethod = 'structured_import';
    } else {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
        profile: Chamber;
        pageCount: number;
        rows: ExtractedFundingRow[];
      };
      if (artifact.profile !== chamber)
        throw new Error(`artifact profile ${artifact.profile} does not match ${chamber}`);
      pageCount = artifact.pageCount;
      parsed =
        chamber === 'house'
          ? parseHousePdfRows(artifact.rows, fiscalYear, subcommittee)
          : parseSenatePdfRows(artifact.rows, fiscalYear, subcommittee);
      documentType = chamber === 'house' ? 'cpf_table' : 'cds_table';
      extractionMethod = 'deterministic_pdf';
    }
    const registry = await upsertSourceDocument(prisma as never, {
      sourceKey,
      sha256,
      fiscalYear,
      budgetCycle: chamber === 'house' ? 'cpf_request' : 'cds_request',
      component: null,
      documentType,
      title: `${chamber === 'house' ? 'House CPF' : 'Senate CDS'} FY${fiscalYear}${subcommittee ? ` ${subcommittee}` : ''}`,
      sourceUrl,
      byteSize: fs.statSync(sourceFile).size,
      pageCount,
      downloadedAt: new Date(),
      artifactPath,
      extractionMethod,
      extractionToolVersion:
        extractionMethod === 'deterministic_pdf' ? 'pymupdf-positioned-words-v1' : 'exceljs',
      metadata: { chamber, requestType: chamber === 'house' ? 'cpf' : 'cds', subcommittee },
    });
    // Release 4 change rail: canonical CPF/CDS ingest now feeds the District
    // Nexus change ledger. The sink runs the deterministic detector and writes
    // district_nexus_change rows through the SAME ingest transaction — a ledger
    // row and its fact row commit or roll back together (fail closed).
    const outcome = await new CommunityFundingUpsertService(
      prisma as unknown as PrismaService,
    ).upsertMany(
      parsed.candidates,
      registry.document.id,
      new Date(),
      createDistrictNexusChangeSink(
        new DistrictNexusChangeWriter(prisma as unknown as PrismaService),
      ),
    );
    const run = await prisma.communityFundingIngestRun.create({
      data: {
        source: sourceKey,
        chamber,
        fiscalYear,
        subcommittee,
        artifactPath,
        artifactSha256: sha256,
        rowsEmitted: parsed.candidates.length,
        upserted: outcome.upserted,
        changed: outcome.changed,
        rejected: parsed.rejected.length,
        status: parsed.rejected.length ? 'warn' : 'ok',
        notes: JSON.stringify({ warnings: parsed.warnings, rejected: parsed.rejected }),
      },
    });
    console.log(
      JSON.stringify(
        {
          runId: run.id,
          documentId: registry.document.id,
          documentCreated: registry.created,
          parsed: parsed.candidates.length,
          rejected: parsed.rejected.length,
          ...outcome,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
