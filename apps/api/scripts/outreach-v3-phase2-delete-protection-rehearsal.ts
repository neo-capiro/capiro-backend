import { PrismaService } from '../src/prisma/prisma.service.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectDeleteBlocked(
  prisma: PrismaService,
  sql: string,
  expectedFragment: string,
): Promise<void> {
  try {
    await prisma.withSystem((tx) => tx.$executeRawUnsafe(sql));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedFragment)) {
      throw new Error(
        `Delete was blocked for the wrong reason; expected ${JSON.stringify(expectedFragment)} in ${message}`,
      );
    }
    return;
  }
  throw new Error(`Delete unexpectedly succeeded: ${sql}`);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const rows = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ session_id: string; proposal_id: string }>>`
        SELECT s.id::text AS session_id, p.id::text AS proposal_id
        FROM outreach_sessions s
        JOIN outreach_command_proposals p ON p.session_id = s.id
        ORDER BY s.created_at ASC, p.created_at ASC
        LIMIT 1
      `,
    );
    const row = rows[0];
    assert(row, 'State-flow rehearsal must leave a session with a proposal for delete protection');

    await expectDeleteBlocked(
      prisma,
      `DELETE FROM outreach_command_proposals WHERE id = '${row.proposal_id}'::uuid`,
      'delete-protected',
    );
    console.log('PASS proposal direct DELETE is trigger-blocked');

    await expectDeleteBlocked(
      prisma,
      `DELETE FROM outreach_sessions WHERE id = '${row.session_id}'::uuid`,
      'delete-protected',
    );
    console.log('PASS session direct DELETE is trigger-blocked');

    const stillPresent = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ sessions: bigint; proposals: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM outreach_sessions WHERE id = CAST(${row.session_id} AS uuid)) AS sessions,
          (SELECT COUNT(*) FROM outreach_command_proposals WHERE id = CAST(${row.proposal_id} AS uuid)) AS proposals
      `,
    );
    assert(
      stillPresent[0]?.sessions === 1n && stillPresent[0]?.proposals === 1n,
      'Blocked deletes must leave session and proposal intact',
    );
    console.log('PASS blocked deletes leave rows intact');

    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_purge', 'on', true)`;
      await tx.$executeRaw`DELETE FROM outreach_sessions WHERE id = CAST(${row.session_id} AS uuid)`;
    });
    const afterPurge = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ sessions: bigint; versions: bigint; events: bigint; proposals: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM outreach_sessions WHERE id = CAST(${row.session_id} AS uuid)) AS sessions,
          (SELECT COUNT(*) FROM outreach_state_versions WHERE session_id = CAST(${row.session_id} AS uuid)) AS versions,
          (SELECT COUNT(*) FROM outreach_events WHERE session_id = CAST(${row.session_id} AS uuid)) AS events,
          (SELECT COUNT(*) FROM outreach_command_proposals WHERE session_id = CAST(${row.session_id} AS uuid)) AS proposals
      `,
    );
    const purged = afterPurge[0];
    assert(
      purged?.sessions === 0n &&
        purged.versions === 0n &&
        purged.events === 0n &&
        purged.proposals === 0n,
      'Explicit audit purge must remove the complete session subtree atomically',
    );
    console.log('PASS explicit audit-purge scope removes complete session subtree');
    console.log('OUTREACH_V3_PHASE2_DELETE_PROTECTION_COMPLETE');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
