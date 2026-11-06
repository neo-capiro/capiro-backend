import type { Prisma, PrismaClient } from '@prisma/client';
import { DIBBS_PROVIDER_UUID, type TangoDibbsSolicitationRow } from './tango-dibbs.mapper.js';

export async function upsertDibbsSolicitation(prisma: PrismaClient, row: TangoDibbsSolicitationRow): Promise<void> {
  const { tangoDibbsId, solicitation, ...fields } = row;
  const write = async (db: Prisma.TransactionClient, storedKey: string) => {
    await db.tangoDibbsSolicitation.upsert({
      where: { tangoDibbsId: storedKey },
      create: { ...row, tangoDibbsId: storedKey },
      // Existing public IDs and assigned numbers survive a stale pending observation.
      update: { ...fields, ...(solicitation == null ? {} : { solicitation }), lastSyncedAt: new Date() },
    });
  };
  if (!DIBBS_PROVIDER_UUID.test(tangoDibbsId)) return write(prisma, tangoDibbsId);

  const uuid = tangoDibbsId.toLowerCase();
  await prisma.$transaction(async tx => {
    // Both writers take the same key before resolving its historical spelling.
    // READ COMMITTED makes a waiter's lookup see the previous holder's commit.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${'tango-dibbs:' + uuid}, 0))`;
    const matches = await tx.$queryRaw<{ key: string }[]>`
      SELECT tango_dibbs_id AS key FROM tango_dibbs_solicitation
      WHERE lower(tango_dibbs_id) = ${uuid} LIMIT 2`;
    if (matches.length > 1) throw new Error(`Ambiguous stored Tango DIBBS UUID: ${uuid}`);
    await write(tx, matches[0]?.key ?? uuid);
  }, { isolationLevel: 'ReadCommitted' });
}
