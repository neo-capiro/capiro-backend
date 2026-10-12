/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildMeriRetrievalProductionReport } from '../src/meri/meri-retrieval-report.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim() || null;
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/report-meri-retrieval-v2.ts requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i]!;
    const equals = option.indexOf('=');
    const flag = equals >= 0 ? option.slice(0, equals) : option;
    if (!['--tenant-id', '--days', '--limit'].includes(flag) ||
        (equals < 0 && (!args[i + 1] || args[i + 1]!.startsWith('--')))) {
      console.error(usage);
      process.exit(2);
    }
    if (equals < 0) i += 1;
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const tenantId = arg('tenant-id');
  if (!tenantId || !UUID_RE.test(tenantId)) {
    throw new Error('A valid --tenant-id UUID is required. This report never scans tenants globally.');
  }
  const days = boundedInteger('days', 7, 1, 365);
  const limit = boundedInteger('limit', 10_000, 1, 50_000);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.clioMessage.findMany({
      where: {
        tenantId,
        role: 'assistant',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      // Deliberately omit body/client relations. Operational retrieval quality
      // only needs the metadata emitted by MeriV3 and a timestamp.
      select: { createdAt: true, metadata: true },
    });
    const report = buildMeriRetrievalProductionReport(rows);
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tenantId,
          window: { since: since.toISOString(), days },
          rowsReturned: rows.length,
          limit,
          limitHit: rows.length >= limit,
          report,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Meri retrieval report failed: ${message}\n`);
  process.exitCode = 1;
});
}
