import { CatalogQuotaPause, GRANT_SHAPE, type FundingCatalogClient } from './funding-catalog.client.js';
import { type FundingCatalogStore } from './funding-catalog.store.js';
import { noticeKey, type RecordData } from './funding-catalog.mapper.js';
import { computeFilterFingerprint } from './tango-store.service.js';
import { TangoError } from './tango.errors.js';
import { readOriginalGrant, storeOriginalGrant } from './funding-grant-original.js';

export interface ReconcileTarget { id: string; key: string; solicitation: string | null }
interface Cursor { phase: 'current' | 'historical'; after: string | null; targets: ReconcileTarget[]; page: number | null; seen: string[]; detail: number }
export const solicitationKey = (value: unknown) => typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
const originalGrantCheckSql = "greatest(coalesce(raw->'grantsGovDocument'->>'observedAt',''),coalesce(raw->'grantsGovDocumentGap'->>'observedAt',''))";
// A full, exact-ID catalog observation already verifies the notice, including
// a genuinely absent description. Do not spend another request for that absence.
// Metadata-only family/history observations do not qualify.
export const noticeSourceCheckSql = `CASE WHEN
  lower(replace(raw_jsonb->'tango'->'payload'->>'notice_id','-',''))=lower(replace(notice_id,'-',''))
  AND jsonb_typeof(raw_jsonb->'tango'->'payload'->'active')='boolean'
  THEN coalesce(raw_jsonb->'tango'->>'observedAt','') ELSE '' END`;

/** Solicitation filters save requests; government notice IDs alone bind updates.
 * An absent record/404 is unresolved evidence, never a closure instruction. */
export function selectReconciliationRows(response: RecordData, targets: ReconcileTarget[]): RecordData[] {
  if (!Array.isArray(response.results) || !('next' in response)) throw new Error('Invalid reconciliation page');
  const allowed = new Set(targets.map(row => solicitationKey(row.solicitation)).filter(Boolean));
  const ids = new Set(targets.map(row => noticeKey(row.key)));
  for (const row of response.results) {
    if (!allowed.has(solicitationKey(row.solicitation_number))) throw new Error('Provider ignored reconciliation filter');
  }
  return response.results.filter((row: RecordData) => ids.has(noticeKey(row.notice_id)));
}

export async function reconcileCatalog(store: FundingCatalogStore, client: FundingCatalogClient,
  kind: 'grant' | 'notice', options: { commit: boolean; maxBatches: number; maxRequests: number; now?: Date;
    originalGrant?: typeof readOriginalGrant }) {
  const source = `sync-tango-funding:reconcile-${kind}s`;
  const fingerprint = computeFilterFingerprint({ version: 2, kind, batchSize: 20, currentFirst: true });
  const saved = await store.observations.readCheckpoint(source, kind, fingerprint);
  const now = options.now ?? new Date();
  const started = saved?.cursor && saved.windowStart ? saved.windowStart : now;
  const cutoff = new Date(started.getTime() - 3 * 86400_000);
  let cursor: Cursor = saved?.cursor ? JSON.parse(saved.cursor) : { phase: 'current', after: null, targets: [], page: null, seen: [], detail: 0 };
  if (!['current','historical'].includes(cursor.phase) || !Array.isArray(cursor.targets) || !Array.isArray(cursor.seen) || !Number.isSafeInteger(cursor.detail)) throw new Error('Invalid reconciliation cursor');
  let processed = 0, unavailable = 0, requests = 0;
  const request: FundingCatalogClient['get'] = async (...args) => {
    if (requests >= options.maxRequests) throw new CatalogQuotaPause('Reconciliation run budget reached');
    requests++; return client.get(...args);
  };
  const checkpoint = async (complete = false) => {
    if (options.commit) await store.observations.writeCheckpoint({ syncVerb: source, resourceType: kind,
      filterFingerprint: fingerprint, cursor: complete ? null : JSON.stringify(cursor),
      windowStart: started.toISOString(), windowEnd: now.toISOString(), rowsProcessed: 0,
      completeness: complete ? 'complete' : 'in_progress' });
  };
  const record = async (target: ReconcileTarget, outcome: string) => {
    if (!options.commit) return;
    // Fixed table/column names, all external values bound. No lifecycle or
    // freshness timestamp is fabricated when the provider cannot find a record.
    const table = kind === 'grant' ? 'federal_grant' : 'sam_opportunity';
    const raw = kind === 'grant' ? 'raw' : 'raw_jsonb';
    await store.prisma.$executeRawUnsafe(`UPDATE ${table} SET ${raw}=jsonb_set(coalesce(${raw},'{}'::jsonb),'{fundingReconciliation}',$1::jsonb) WHERE id::text=$2`,
      JSON.stringify({ checkedAt: now.toISOString(), outcome, provider: outcome === 'observed_original_source' ? 'grants.gov'
        : outcome === 'not_found_in_either_source' ? 'tango+grants.gov' : 'tango' }), target.id);
  };
  const save = async (payload: RecordData, target: ReconcileTarget) => {
    if (kind === 'grant') {
      if (String(payload.grant_id) !== target.key) throw new Error('Grant detail identity mismatch');
      await store.grant(payload, options.commit);
    } else {
      if (noticeKey(payload.notice_id) !== noticeKey(target.key)) throw new Error('Notice detail identity mismatch');
      await store.notice(payload, options.commit);
    }
    await record(target, 'observed'); processed++;
  };
  try {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      if (!cursor.targets.length) {
        const table = kind === 'grant' ? 'federal_grant' : 'sam_opportunity';
        const raw = kind === 'grant' ? 'raw' : 'raw_jsonb';
        const changed = kind === 'grant' ? 'synced_at' : 'last_synced_at';
        // Exact-ID original reads already verify the same record during the
        // document gap pass. Reuse their dated evidence, including explicit
        // unavailable outcomes; never fabricate a new source observation.
        const checkedAt = kind === 'grant'
          ? `greatest(coalesce(raw->'fundingReconciliation'->>'checkedAt',''),${originalGrantCheckSql})`
          : `greatest(coalesce(raw_jsonb->'fundingReconciliation'->>'checkedAt',''),${noticeSourceCheckSql})`;
        // Grants' current provider catalog exposes P/F only. Historical grants
        // already held locally are preserved; do not spend one 404 per archive row.
        const eligible = kind === 'grant' ? "status IN ('posted','forecasted')" : 'TRUE';
        const current = kind === 'grant' ? '(close_date IS NULL OR close_date >= $4::timestamptz::date)'
          : '(active AND (response_deadline IS NULL OR response_deadline >= $4::timestamptz))';
        cursor.targets = await store.prisma.$queryRawUnsafe<ReconcileTarget[]>(`SELECT id::text,
          ${kind === 'grant' ? 'id::text' : 'notice_id'} AS key,
          ${kind === 'grant' ? 'NULL::text' : 'solicitation_number'} AS solicitation FROM ${table}
          WHERE ($1::text IS NULL OR id::text>$1) AND ${eligible}
          AND coalesce((${current}),false)=$5
          AND ${checkedAt}<$2
          AND (${changed}<$3 OR ${raw}->'tango' IS NULL OR length(coalesce(description,''))<11)
          ORDER BY id::text LIMIT 20`, cursor.after, cutoff.toISOString(), cutoff, started, cursor.phase === 'current');
        if (!cursor.targets.length) {
          if (cursor.phase === 'current') {
            cursor = { phase: 'historical', after: null, targets: [], page: null, seen: [], detail: 0 };
            await checkpoint(); continue;
          }
          await checkpoint(true); return { processed, unavailable, complete: true };
        }
        cursor.page = kind === 'notice' && cursor.targets.some(x => x.solicitation && !x.solicitation.includes('|')) ? 1 : null;
        cursor.seen = []; cursor.detail = 0;
        await checkpoint(); // Persist selection before writes can change eligibility.
      }
      const bulk = cursor.targets.filter(x => x.solicitation && !x.solicitation.includes('|') && /^[a-f\d]{32}$/i.test(x.key.replace(/-/g,'')));
      while (cursor.page !== null && bulk.length) {
        const page = cursor.page;
        const response = await request('notices', { solicitation_number: [...new Set(bulk.map(x => x.solicitation))].join('|'), limit: 100, page });
        // Validate every returned solicitation before any write. Reuse extra
        // results only when their government ID matches an existing local row.
        selectReconciliationRows(response, bulk);
        if (response.next && Number(new URL(response.next, 'https://tango.dev').searchParams.get('page')) !== page + 1) throw new Error('Unexpected reconciliation page progression');
        for (const row of response.results) {
          let target = bulk.find(x => noticeKey(x.key) === noticeKey(row.notice_id));
          if (!target) {
            const local = await store.findNotice(row.notice_id);
            if (!local) continue;
            target = { id: local.id, key: local.noticeId, solicitation: local.solicitationNumber };
          }
          await save(row, target);
          if (bulk.some(selected => selected.id === target.id) && !cursor.seen.includes(target.id)) cursor.seen.push(target.id);
        }
        cursor.page = response.next ? page + 1 : null;
        await checkpoint();
      }
      while (cursor.detail < cursor.targets.length) {
        const target = cursor.targets[cursor.detail]!;
        // A saved selection may predate a completed original-document pass.
        // Advancing its cursor reuses that evidence without rewriting dates.
        const checkedSql = kind === 'grant'
          ? `SELECT 1 AS checked FROM federal_grant WHERE id=$1 AND ${originalGrantCheckSql}>=$2`
          : `SELECT 1 AS checked FROM sam_opportunity WHERE id=$1::uuid AND (${noticeSourceCheckSql})>=$2`;
        if ((await store.prisma.$queryRawUnsafe<Array<{ checked: number }>>(
          checkedSql, target.id, cutoff.toISOString())).length) {
          cursor.detail++; await checkpoint(); continue;
        }
        if (!cursor.seen.includes(target.id)) {
          if (kind === 'notice' && !/^[a-f\d]{32}$/i.test(target.key.replace(/-/g,''))) {
            await record(target, 'invalid_government_identifier'); unavailable++;
          } else {
            try {
              const payload = await request(kind === 'grant' ? 'grants' : 'notices', kind === 'grant' ? { shape: GRANT_SHAPE } : {}, target.key);
              await save(payload, target);
            } catch (error) {
              if (!(error instanceof TangoError) || error.kind !== 'not_found') throw error;
              if (kind === 'grant') {
                const payload = await (options.originalGrant ?? readOriginalGrant)(target.key);
                if (payload) {
                  await storeOriginalGrant(store, target.key, payload, options.commit);
                  await record(target, 'observed_original_source'); processed++;
                } else { await record(target, 'not_found_in_either_source'); unavailable++; }
              } else { await record(target, 'not_found'); unavailable++; }
            }
          }
        }
        cursor.detail++; await checkpoint();
      }
      cursor = { phase: cursor.phase, after: cursor.targets.at(-1)!.id, targets: [], page: null, seen: [], detail: 0 };
      await checkpoint();
    }
  } catch (error) {
    if (!(error instanceof CatalogQuotaPause)) throw error;
  }
  return { processed, unavailable, complete: false };
}
