/**
 * Backfill legacy free-text sectors into the controlled SECTOR_TAGS enum.
 *
 * - For every client with sector_tag IS NULL, attempt to derive it from
 *   intake_data.sector / intake_data.tags / intake_data.portfolio via
 *   normalizeSector(). If a clean enum match is found, set client.sector_tag.
 * - For every client_capability with a non-enum sector, normalize through
 *   normalizeSector() and rewrite the column to the canonical enum value when
 *   a clean match exists. Free-text sectors that don't normalize cleanly are
 *   left alone (they still work via the on-read normalization in
 *   getCommentPeriodAlerts).
 *
 * Idempotent, safe to run multiple times. Outputs a summary of changes.
 *
 *   pnpm --filter @capiro/api backfill:sectors
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { normalizeSector, SECTOR_TAGS } from '@capiro/shared';

dotenvConfig();

const enumSet = new Set<string>(SECTOR_TAGS);

async function backfillClients(prisma: PrismaClient) {
  const clients = await prisma.client.findMany({
    where: { sectorTag: null },
    select: { id: true, name: true, intakeData: true },
  });

  let updated = 0;
  let skipped = 0;
  for (const c of clients) {
    const intake = (c.intakeData ?? {}) as Record<string, unknown>;
    const candidates: Array<string | null | undefined> = [
      typeof intake.sector === 'string' ? intake.sector : null,
    ];
    if (Array.isArray(intake.portfolio)) {
      for (const p of intake.portfolio) if (typeof p === 'string') candidates.push(p);
    }
    if (Array.isArray(intake.tags)) {
      for (const t of intake.tags) if (typeof t === 'string') candidates.push(t);
    }

    let resolved: string | null = null;
    for (const cand of candidates) {
      const n = normalizeSector(cand);
      if (n) { resolved = n; break; }
    }

    if (resolved) {
      await prisma.client.update({ where: { id: c.id }, data: { sectorTag: resolved } });
      console.log(`  client ${c.id} (${c.name}) -> sectorTag=${resolved}`);
      updated++;
    } else {
      skipped++;
    }
  }
  console.log(`Clients: ${updated} updated, ${skipped} skipped (no clean enum match)`);
}

async function backfillCapabilities(prisma: PrismaClient) {
  const caps = await prisma.clientCapability.findMany({
    where: { sector: { not: null } },
    select: { id: true, name: true, sector: true },
  });

  let updated = 0;
  let already = 0;
  let skipped = 0;
  for (const cap of caps) {
    if (!cap.sector) { skipped++; continue; }
    if (enumSet.has(cap.sector)) { already++; continue; }
    const n = normalizeSector(cap.sector);
    if (n) {
      await prisma.clientCapability.update({
        where: { id: cap.id },
        data: { sector: n },
      });
      console.log(`  capability ${cap.id} (${cap.name}): "${cap.sector}" -> ${n}`);
      updated++;
    } else {
      skipped++;
    }
  }
  console.log(`Capabilities: ${updated} normalized, ${already} already-enum, ${skipped} skipped`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/backfill-sector-tags.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    console.log('=== Backfilling client.sectorTag ===');
    await backfillClients(prisma);
    console.log();
    console.log('=== Normalizing client_capabilities.sector ===');
    await backfillCapabilities(prisma);
    console.log();
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
