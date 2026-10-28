import type { FundingCatalogStore } from './funding-catalog.store.js';
import { readOriginalGrant, storeOriginalGrant } from './funding-grant-original.js';
import { computeFilterFingerprint } from './tango-store.service.js';

/** Known current grants with an empty or unobserved Tango attachment catalog.
 * This is a lane of the locked canonical writer, not an independent catalog. */
export async function fillGrantDocumentGaps(store: FundingCatalogStore, options: {
  commit: boolean; limit: number; read?: typeof readOriginalGrant; delayMs?: number;
}) {
  const source = 'sync-tango-funding:grant-documents', fingerprint = computeFilterFingerprint({ version: 2, currentOnly: true, includeUnobserved: true });
  const checkpoint = await store.observations.readCheckpoint(source, 'grant', fingerprint);
  const start = checkpoint?.cursor && checkpoint.windowStart ? checkpoint.windowStart : new Date();
  const cutoff = new Date(start.getTime() - 3 * 86400_000).toISOString();
  let after = checkpoint?.cursor ?? null, processed = 0, unavailable = 0, complete = false;
  const save = async () => {
    if (options.commit) await store.observations.writeCheckpoint({ syncVerb: source, resourceType: 'grant', filterFingerprint: fingerprint,
      cursor: complete ? null : after, windowStart: start.toISOString(), windowEnd: new Date().toISOString(),
      rowsProcessed: complete ? 0 : 1, completeness: complete ? 'complete' : 'in_progress' });
  };
  while (processed + unavailable < options.limit) {
    const rows = await store.prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM federal_grant
      WHERE ($1::text IS NULL OR id>$1) AND status IN ('posted','forecasted') AND (close_date IS NULL OR close_date>=CURRENT_DATE)
      AND (raw->'tango' IS NULL OR raw->'tango'->'payload'->'attachments'='[]'::jsonb)
      AND greatest(coalesce(raw->'grantsGovDocument'->>'observedAt',''),coalesce(raw->'grantsGovDocumentGap'->>'observedAt',''))<$2 ORDER BY id LIMIT 1`, after, cutoff);
    const target = rows[0];
    if (!target) { complete = true; await save(); break; }
    const payload = await (options.read ?? readOriginalGrant)(target.id);
    if (payload) { await storeOriginalGrant(store, target.id, payload, options.commit, 'tango_attachment_gap'); processed++; }
    else {
      unavailable++;
      if (options.commit) await store.prisma.$executeRawUnsafe("UPDATE federal_grant SET raw=jsonb_set(coalesce(raw,'{}'::jsonb),'{grantsGovDocumentGap}',$1::jsonb) WHERE id=$2",
        JSON.stringify({ observedAt: new Date().toISOString(), outcome: 'not_found', source: 'grants.gov' }), target.id);
    }
    after = target.id; await save();
    if ((processed + unavailable) % 100 === 0) console.log(JSON.stringify({ event: 'GRANT_DOCUMENT_GAP_PROGRESS', processed, unavailable }));
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 600));
  }
  return { processed, unavailable, complete };
}
