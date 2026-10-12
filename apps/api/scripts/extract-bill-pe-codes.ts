/** @cleanup-smoke noArgsExit=2 */
/**
 * Step 21 — Bill text PE-code extraction.
 *
 *   pnpm --filter @capiro/api extract:bill-pe-codes
 *   tsx scripts/extract-bill-pe-codes.ts [--no-full-text]
 *
 * Scans every CongressBill's text (title + latest action + cached/fetched full
 * text from GovInfo) for Program Element codes, filters to PEs that exist in
 * program_element, upserts the set onto the bill, and emits an IntelligenceChange
 * when the set changed and a newly-added PE is watched.
 *
 * Idempotent: a second run with no source changes performs no writes.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/config.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GovInfoService } from '../src/external/govinfo/govinfo.service.js';
import { BillPeExtractorService } from '../src/program-element/extractors/bill-pe-extractor.service.js';

dotenvConfig();

async function main(): Promise<void> {
  const fetchFullText = !process.argv.includes('--no-full-text');
  if (!process.env.DATABASE_URL) {
    console.error('Usage: extract-bill-pe-codes [--no-full-text] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  await prisma.$connect();

  // Minimal ConfigService over process.env so GovInfoService can read its key +
  // bucket without bootstrapping the whole Nest AppModule.
  const config = {
    get: (k: keyof AppConfig) => process.env[k as string],
  } as unknown as ConfigService<AppConfig, true>;

  // PrismaService is a PrismaClient superset (adds withTenant/withSystem), so it
  // works for plain delegate calls AND any RLS-aware helper the services use.
  const prismaService = prisma;
  const govInfo = new GovInfoService(prismaService, config);
  const extractor = new BillPeExtractorService(prismaService, govInfo);

  const startedAt = Date.now();
  try {
    const results = await extractor.run({ fetchFullText });
    const changed = results.filter((r) => r.changed).length;
    const emitted = results.filter((r) => r.emitted).length;
    const withCodes = results.filter((r) => r.peCodes.length > 0).length;
    console.log(
      JSON.stringify(
        {
          bills_scanned: results.length,
          bills_with_pe_codes: withCodes,
          bills_changed: changed,
          intelligence_changes_emitted: emitted,
          full_text_fetch: fetchFullText,
          duration_seconds: Math.round((Date.now() - startedAt) / 1000),
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
