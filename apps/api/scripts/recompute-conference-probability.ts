import { config as dotenvConfig } from 'dotenv';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConferenceProbabilityService } from '../src/program-element/models/conference-probability.service.js';

dotenvConfig();

interface ActiveYearRow {
  peCode: string;
  fy: number;
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const service = new ConferenceProbabilityService(prisma);

    const activeYears = await prisma.$queryRaw<ActiveYearRow[]>(Prisma.sql`
      SELECT y.pe_code AS "peCode", y.fy AS "fy"
      FROM program_element_year y
      WHERE y.hasc_mark IS NOT NULL
        AND y.sasc_mark IS NOT NULL
        AND y.ndaa_conference IS NULL
    `);

    let computed = 0;
    let skipped = 0;

    for (const row of activeYears) {
      const prediction = await service.predict(row.peCode, row.fy);
      if (prediction) computed += 1;
      else skipped += 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          scanned: activeYears.length,
          computed,
          skipped,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
