import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import { withStateBillWriter } from './state-bill-writer.js';

const SOURCE_SCOPE =
  'Parent history/progress event in [2025-10-01,2026-10-01); all listed versions retained';
/** Freeze the independently captured discovery denominator, including explicit
 * empty jurisdictions. Per-session archive receipts prove their own inventory;
 * neither receipt asserts that texts or embeddings have been downloaded. */
export function inspectStateDiscovery(bytes: Buffer, manifestSha256: string) {
  if (
    !bytes.length ||
    bytes.length > 2000000 ||
    !/^[a-f\d]{64}$/.test(manifestSha256) ||
    createHash('sha256').update(bytes).digest('hex') !== manifestSha256
  )
    throw Error('DISCOVERY_MANIFEST_HASH_OR_SIZE');
  const source = JSON.parse(bytes.toString('utf8'));
  if (
    source.scope !== SOURCE_SCOPE ||
    source.completeStates !== 51 ||
    !Array.isArray(source.states) ||
    source.states.length !== 51 ||
    typeof source.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(source.updatedAt)) ||
    !/^[a-f\d]{40}$/.test(source.sourceCommit ?? '')
  )
    throw Error('DISCOVERY_MANIFEST_INCOMPLETE');
  const states: Array<{
    state: string;
    status: 'complete';
    sessions: Array<{ sessionId: number; archiveHash: string; expectedBills: number }>;
  }> = [];
  const seenStates = new Set<string>(),
    seenSessions = new Set<number>();
  for (const item of source.states) {
    if (
      !item ||
      (ALL_US_STATE_CODES as readonly string[]).indexOf(item.state) < 0 ||
      seenStates.has(item.state) ||
      item.status !== 'complete' ||
      !Array.isArray(item.sessions)
    )
      throw Error('DISCOVERY_JURISDICTION_INCOMPLETE');
    seenStates.add(item.state);
    const sessions = item.sessions
      .map((session: any) => {
        if (
          !session ||
          !Number.isSafeInteger(session.id) ||
          session.id < 1 ||
          seenSessions.has(session.id) ||
          !/^[a-f\d]{64}$/.test(session.archiveSha256 ?? '') ||
          !Number.isSafeInteger(session.bills) ||
          session.bills < 1 ||
          session.bills > 50000 ||
          !Number.isSafeInteger(session.archiveBytes) ||
          session.archiveBytes < 1 ||
          session.archiveBytes > 120000000
        )
          throw Error('DISCOVERY_SESSION_INVALID');
        seenSessions.add(session.id);
        return {
          sessionId: session.id,
          archiveHash: session.archiveSha256,
          expectedBills: session.bills,
        };
      })
      .sort((a: any, b: any) => a.sessionId - b.sessionId);
    states.push({ state: item.state, status: 'complete', sessions });
  }
  if (seenSessions.size > 500) throw Error('DISCOVERY_SESSION_LIMIT');
  return {
    schemaVersion: 1,
    fiscalYear: 2026,
    manifestSha256,
    observedAt: source.updatedAt,
    sourceCommit: source.sourceCommit,
    states: states.sort((a, b) => a.state.localeCompare(b.state)),
  };
}

export async function retainStateDiscovery(
  prisma: PrismaClient,
  bytes: Buffer,
  manifestSha256: string,
) {
  const manifest = inspectStateDiscovery(bytes, manifestSha256),
    scope = { fiscalYear: 2026, manifestSha256 };
  const id = createHash('sha256')
    .update(JSON.stringify(['fy26-state-discovery', 1, manifestSha256]))
    .digest('hex');
  return withStateBillWriter(prisma, ALL_US_STATE_CODES, async (writer) => {
    await writer.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES(${manifestSha256},${bytes.toString('base64')}) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${id},'fy26-state-discovery',${JSON.stringify(scope)}::jsonb,${JSON.stringify(manifest)}::jsonb,true) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM legal_source_receipt WHERE id=${id} AND source='fy26-state-discovery'
        AND scope=${JSON.stringify(scope)}::jsonb AND manifest=${JSON.stringify(manifest)}::jsonb AND complete
        AND EXISTS(SELECT 1 FROM legal_dataset_archive WHERE content_hash=${manifestSha256} AND original_bytes_base64=${bytes.toString('base64')})`;
      if (rows.length !== 1) throw Error('DISCOVERY_IMMUTABLE_RECEIPT_CONFLICT');
    });
    return {
      receiptId: id,
      manifestSha256,
      jurisdictions: 51,
      sessions: manifest.states.reduce((n, s) => n + s.sessions.length, 0),
      providerCalls: 0,
      inventoryOnly: true,
    };
  });
}
