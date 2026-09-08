#!/usr/bin/env tsx
/**
 * Generate the same Word report card served by the client-profile export.
 * Usage: tsx scripts/generate-report-card-docx.ts <clientId> <tenantId> [--period quarter|year]
 * Output: a .docx in the operating system's temporary directory.
 * Reads client-scoped data only; does not start application schedulers.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema, type AppConfig } from '../src/config/config.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { LobbyIntelService } from '../src/lobby-intel/lobby-intel.service.js';
import { FederalSpendingService } from '../src/federal-spending/federal-spending.service.js';
import { InsightGeneratorService } from '../src/intelligence/insight-generator.service.js';
import { ReportCardService } from '../src/intelligence/report-card.service.js';
import { renderReportCardDocx, reportCardFilename } from '../src/intelligence/report-card-docx.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { period: { type: 'string', default: 'quarter' } },
  });
  const [clientId, tenantId] = positionals;
  if (!clientId || !tenantId || positionals.length !== 2) {
    throw new Error(
      'Usage: generate-report-card-docx.ts <clientId> <tenantId> [--period quarter|year]',
    );
  }
  if (values.period !== 'quarter' && values.period !== 'year') {
    throw new Error('--period must be quarter or year');
  }

  // Reuse the API's configured model defaults and canonical services without
  // bootstrapping AppModule (which would also start background jobs).
  const config = new ConfigService<AppConfig, true>(
    configSchema
      .pick({
        OPENAI_API_KEY: true,
        ANTHROPIC_API_KEY: true,
        AI_PROVIDER: true,
        OPENAI_MODEL: true,
        ANTHROPIC_MODEL: true,
      })
      .parse(process.env),
  );
  const prisma = new PrismaService();
  try {
    const insight = new InsightGeneratorService(
      config,
      prisma,
      new LobbyIntelService(prisma),
      new FederalSpendingService(prisma),
    );
    const report = await new ReportCardService(prisma, insight).generateReportCard(
      clientId,
      tenantId,
      values.period,
    );
    const outputPath = join(tmpdir(), reportCardFilename(report));
    await writeFile(outputPath, await renderReportCardDocx(report));
    console.log(`Report card written to: ${outputPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
