import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';

export type StateBillDiscovery = {
  receiptId: string;
  manifestSha256: string;
  states: Array<{
    state: string;
    sessions: Array<{ sessionId: number; archiveHash: string; expectedBills: number }>;
  }>;
};
export type BillJurisdictionInventory = {
  jurisdiction: string;
  known: boolean;
  expectedSessions: number;
  qualifiedSessions: number;
  missingSessions: string[];
};
export type StateBillSessionReceipt = {
  jurisdiction: string;
  sessionId: string;
  archiveHash: string;
  expectedBills: number;
  receiptId: string | null;
  qualified: boolean;
};
type DiscoveryRow = { id: string; scope: unknown; manifest: unknown; archived: boolean };
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** The existing ingestion owner verifies and archives exact manifest bytes before this immutable receipt is usable. */
export const STATE_BILL_DISCOVERY_SQL = `SELECT r.id,r.scope,r.manifest,a.content_hash IS NOT NULL AS archived
 FROM legal_source_receipt r LEFT JOIN legal_dataset_archive a ON a.content_hash=r.scope->>'manifestSha256'
 WHERE r.source='fy26-state-discovery' AND r.scope->>'fiscalYear'='2026' AND r.complete
 ORDER BY r.observed_at DESC,r.id DESC LIMIT 1`;

export function parseStateBillDiscovery(row: DiscoveryRow | undefined): StateBillDiscovery | null {
  if (!row?.archived) return null;
  const scope = object(row.scope),
    manifest = object(row.manifest);
  if (
    !scope ||
    !manifest ||
    scope.fiscalYear !== 2026 ||
    manifest.fiscalYear !== 2026 ||
    manifest.schemaVersion !== 1 ||
    !hash(scope.manifestSha256) ||
    manifest.manifestSha256 !== scope.manifestSha256 ||
    !Array.isArray(manifest.states) ||
    manifest.states.length !== 51
  )
    return null;
  const states: StateBillDiscovery['states'] = [];
  const seenStates = new Set<string>(),
    seenSessions = new Set<number>();
  for (const value of manifest.states) {
    const state = object(value);
    if (
      !state ||
      typeof state.state !== 'string' ||
      !(ALL_US_STATE_CODES as readonly string[]).includes(state.state) ||
      seenStates.has(state.state) ||
      state.status !== 'complete' ||
      !Array.isArray(state.sessions)
    )
      return null;
    seenStates.add(state.state);
    const sessions: StateBillDiscovery['states'][number]['sessions'] = [];
    for (const value of state.sessions) {
      const session = object(value);
      if (
        !session ||
        typeof session.sessionId !== 'number' ||
        !Number.isSafeInteger(session.sessionId) ||
        session.sessionId < 1 ||
        seenSessions.has(session.sessionId) ||
        !hash(session.archiveHash) ||
        typeof session.expectedBills !== 'number' ||
        !Number.isSafeInteger(session.expectedBills) ||
        session.expectedBills < 0
      )
        return null;
      seenSessions.add(session.sessionId);
      sessions.push({
        sessionId: session.sessionId,
        archiveHash: session.archiveHash,
        expectedBills: session.expectedBills,
      });
    }
    states.push({ state: state.state, sessions });
  }
  return { receiptId: row.id, manifestSha256: scope.manifestSha256, states };
}

/** A later ZIP or incomplete receipt cannot silently change a frozen discovery denominator. */
export const STATE_BILL_SESSION_RECEIPTS_SQL = `WITH expected AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) e(jurisdiction text,"sessionId" text,"archiveHash" text,"expectedBills" int)
)
SELECT e.*,r.id AS "receiptId",coalesce(r.complete AND a.content_hash IS NOT NULL
 AND r.manifest->>'schemaVersion'='1' AND r.manifest->>'sourceListComplete'='true'
 AND r.manifest->>'archiveHash'=e."archiveHash" AND r.manifest->>'state'=e.jurisdiction
 AND r.manifest->>'sessionId'=e."sessionId" AND r.manifest->>'inspectedBills'=e."expectedBills"::text
 AND r.manifest->>'eligibleBills'=(CASE WHEN jsonb_typeof(r.manifest->'bills')='array' THEN jsonb_array_length(r.manifest->'bills') END)::text,false) AS qualified
FROM expected e LEFT JOIN LATERAL (
 SELECT r.* FROM legal_source_receipt r WHERE r.source='fy26-state-frozen-inventory'
 AND r.scope->>'fiscalYear'='2026' AND r.scope->>'jurisdiction'=e.jurisdiction
 AND r.scope->>'providerSessionId'=e."sessionId" AND r.scope->>'archiveHash'=e."archiveHash"
 ORDER BY r.complete DESC,r.observed_at DESC,r.id DESC LIMIT 1
) r ON true LEFT JOIN legal_dataset_archive a ON a.content_hash=e."archiveHash"`;

export function stateBillJurisdictionInventories(
  discovery: StateBillDiscovery | null,
  receipts: readonly StateBillSessionReceipt[],
): BillJurisdictionInventory[] {
  if (!discovery) return [];
  return discovery.states.map((state) => {
    const missing = state.sessions.filter(
      (session) =>
        !receipts.some(
          (receipt) =>
            receipt.qualified &&
            receipt.receiptId &&
            receipt.jurisdiction === state.state &&
            receipt.sessionId === String(session.sessionId) &&
            receipt.archiveHash === session.archiveHash,
        ),
    );
    return {
      jurisdiction: state.state,
      known: missing.length === 0,
      expectedSessions: state.sessions.length,
      qualifiedSessions: state.sessions.length - missing.length,
      missingSessions: missing.map((session) => String(session.sessionId)),
    };
  });
}

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };
export async function loadPinnedStateInventory(db: Reader, jurisdiction?: string) {
  if (
    jurisdiction !== undefined &&
    !(ALL_US_STATE_CODES as readonly string[]).includes(jurisdiction)
  )
    throw Error('INVALID_STATE_INVENTORY_JURISDICTION');
  const rows = await db.$queryRawUnsafe<DiscoveryRow[]>(STATE_BILL_DISCOVERY_SQL);
  const discovery = parseStateBillDiscovery(rows[0]);
  const selectedStates =
    discovery?.states.filter((state) => !jurisdiction || state.state === jurisdiction) ?? [];
  const expected = selectedStates.flatMap((state) =>
    state.sessions.map((session) => ({
      jurisdiction: state.state,
      ...session,
      sessionId: String(session.sessionId),
    })),
  );
  const sessions = expected.length
    ? await db.$queryRawUnsafe<StateBillSessionReceipt[]>(
        STATE_BILL_SESSION_RECEIPTS_SQL,
        JSON.stringify(expected),
      )
    : [];
  return {
    discovery,
    sessions,
    inventories: stateBillJurisdictionInventories(discovery, sessions).filter(
      (state) => !jurisdiction || state.jurisdiction === jurisdiction,
    ),
    qualifiedReceiptIds: sessions
      .filter((session) => session.qualified && session.receiptId)
      .map((session) => session.receiptId!),
  };
}
