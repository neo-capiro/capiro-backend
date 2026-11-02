import type { PrismaClient } from '@prisma/client';
import { fetchCongressSubjects } from './congress-classifications.js';
import {
  enrichFederalBulkMetadata,
  writeFederalReceipt,
  type FederalReceipt,
} from './federal-billstatus-import.js';
import {
  federalDate,
  federalIdentity,
  federalObject,
  normalizeFederalCosponsors,
} from './federal-billstatus.js';
import type { FederalGeneration, FederalJsonFetch } from './federal-bill-inventory.js';

/** Strictly paginated targeted refresh for the small set newer than the frozen ZIP. */
export async function fetchFederalMetadata(
  billId: string,
  apiKey: string,
  fetchJson: FederalJsonFetch,
) {
  const [congress, type, number] = billId.split('-'),
    base = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}`;
  const call = (path: string) => {
    const url = new URL(path);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    return fetchJson(url.href);
  };
  const before = federalObject(federalObject(await call(base)).bill);
  if (federalIdentity(before) !== billId || !federalDate(before.updateDate))
    throw Error('FEDERAL_METADATA_IDENTITY_OR_DATE_INVALID');
  async function all(resource: 'subjects' | 'cosponsors') {
    const values: unknown[] = [],
      seen = new Set<number>();
    let next: string | null = `${base}/${resource}?limit=250&offset=0`,
      expected: number | null = null,
      received = 0;
    while (next) {
      const url = new URL(next),
        offset = Number(url.searchParams.get('offset') ?? 0);
      if (
        url.origin !== 'https://api.congress.gov' ||
        url.pathname !== `${new URL(base).pathname}/${resource}` ||
        url.username ||
        url.password ||
        url.hash ||
        offset !== received ||
        seen.has(offset)
      )
        throw Error('FEDERAL_METADATA_PAGINATION_SCOPE_INVALID');
      seen.add(offset);
      url.searchParams.set('limit', '250');
      const response = federalObject(await call(url.href)),
        pagination = federalObject(response.pagination);
      let page: unknown[],
        policyAreaCount = 0;
      if (resource === 'subjects') {
        const normalized = await fetchCongressSubjects(async () => response);
        if (!normalized.ok) throw Error('FEDERAL_METADATA_SUBJECTS_INCOMPLETE');
        page = normalized.data;
        const policyArea = response.subjects.policyArea;
        if (policyArea !== undefined && policyArea !== null) {
          if (
            typeof policyArea !== 'object' ||
            Array.isArray(policyArea) ||
            typeof policyArea.name !== 'string' ||
            !policyArea.name.trim()
          )
            throw Error('FEDERAL_METADATA_SUBJECTS_INCOMPLETE');
          policyAreaCount = 1;
        }
      } else {
        if (!Array.isArray(response.cosponsors))
          throw Error('FEDERAL_METADATA_COSPONSORS_INCOMPLETE');
        page = response.cosponsors;
      }
      const pageCount = page.length + policyAreaCount;
      const count =
        resource === 'cosponsors'
          ? (pagination.countIncludingWithdrawnCosponsors ?? pagination.count)
          : pagination.count;
      // Subjects without pagination are documented as one complete subresource;
      // cosponsors require their explicit total, including withdrawn episodes.
      const total =
        resource === 'subjects' && count === undefined && !pagination.next ? pageCount : count;
      if (
        !Number.isInteger(total) ||
        total < 0 ||
        total > 10000 ||
        (expected !== null && expected !== total)
      )
        throw Error('FEDERAL_METADATA_COUNT_INVALID');
      expected = total;
      values.push(...page);
      // The subjects endpoint paginates legislative subjects AND policy area.
      // Track its raw cardinality without storing policyArea as a legislative subject.
      received += pageCount;
      next = pagination.next ?? null;
      if (received > total || (next !== null && (!pageCount || typeof next !== 'string' || !next)))
        throw Error('FEDERAL_METADATA_TRUNCATED');
    }
    if (received !== expected) throw Error('FEDERAL_METADATA_TRUNCATED');
    return values;
  }
  const subjects = (await all('subjects')) as string[],
    cosponsors = normalizeFederalCosponsors(await all('cosponsors'));
  const after = federalObject(federalObject(await call(base)).bill);
  if (federalIdentity(after) !== billId || after.updateDate !== before.updateDate)
    throw Error('FEDERAL_METADATA_CHANGED_DURING_FETCH');
  return {
    id: billId,
    eligible: true,
    providerUpdatedAt: before.updateDateIncludingText ?? before.updateDate,
    metadataUpdatedAt: before.updateDate,
    subjects: [...new Set(subjects)].sort(),
    cosponsors: cosponsors.current,
    cosponsorEpisodes: cosponsors.episodes,
    versions: [],
    amendments: [],
  };
}
export async function refreshHeldFederalMetadata(
  db: PrismaClient,
  generation: FederalGeneration,
  options: { limit: number; apiKey: string; fetchJson: FederalJsonFetch; check?: () => void },
) {
  const rows = await db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT DISTINCT ON(scope->>'billId') id,scope,manifest,complete,observed_at AS "observedAt" FROM legal_source_receipt
    WHERE source='fy26-federal-metadata' AND scope->>'archiveHash'=ANY($1::text[])
    AND ($2::text IS NULL OR scope->>'refreshId'=$2) ORDER BY scope->>'billId',complete DESC,observed_at DESC,id DESC`,
    generation.archiveHashes,
    generation.refreshId ?? null,
  );
  const held = rows
    .filter(
      (row) =>
        !row.complete && generation.billArchives.get(row.scope.billId) === row.scope.archiveHash,
    )
    .sort((a, b) => a.scope.billId.localeCompare(b.scope.billId));
  const source = `fy26-federal-metadata:${generation.inventoryHash}`;
  await db.$executeRawUnsafe(
    'INSERT INTO federal_evidence_checkpoint(source,status,cursor_jsonb) VALUES($1,\'running\',\'{"after":""}\'::jsonb) ON CONFLICT DO NOTHING',
    source,
  );
  const checkpoints = await db.$queryRawUnsafe<Array<{ cursor: { after: string } }>>(
    'SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=$1',
    source,
  );
  const after = checkpoints[0]?.cursor.after;
  if (typeof after !== 'string') throw Error('FEDERAL_METADATA_CHECKPOINT_INVALID');
  const ordered = [
    ...held.filter((r) => r.scope.billId > after),
    ...held.filter((r) => r.scope.billId <= after),
  ];
  let processed = 0,
    failed = 0,
    capped = false;
  for (const row of ordered.slice(0, options.limit)) {
    options.check?.();
    try {
      const bill = await fetchFederalMetadata(row.scope.billId, options.apiKey, options.fetchJson);
      if (
        (await enrichFederalBulkMetadata(
          db,
          bill,
          row.scope.archiveHash,
          'congress-api',
          generation.refreshId,
        )) !== 'enriched'
      )
        throw Error('FEDERAL_METADATA_CANONICAL_NEWER');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'FEDERAL_METADATA_FAILED';
      if (message === 'CONGRESS_REQUEST_CAP_REACHED' || message === 'FEDERAL_REFRESH_DEADLINE') {
        capped = true;
        break;
      }
      if (message.startsWith('FEDERAL_WRITER_')) throw error;
      failed++;
      await writeFederalReceipt(
        db,
        'fy26-federal-metadata-attempt',
        row.scope,
        {
          schemaVersion: 1,
          status: 'failed',
          error: message.replace(/api_key=[^&\s]+/gi, 'api_key=[REDACTED]').slice(0, 500),
          attemptedAt: new Date().toISOString(),
        },
        false,
      );
    }
    processed++;
    await db.$executeRawUnsafe(
      'UPDATE federal_evidence_checkpoint SET cursor_jsonb=$2::jsonb,updated_at=clock_timestamp() WHERE source=$1',
      source,
      JSON.stringify({ after: row.scope.billId }),
    );
  }
  return {
    processed,
    failed,
    capped,
    remaining: held.length - processed + failed,
    complete: held.length === processed && failed === 0,
  };
}
