import type { PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { fetchCongressJson } from './congress-http.js';
import { FEDERAL_FY26_SQL } from './bill-text-scope.js';
import {
  FEDERAL_BILL_TYPES,
  federalHash,
  federalObject,
  normalizeFederalVersions,
  replayFederalExactDuplicates,
  type FederalExactDuplicateProof,
  type FederalAmendmentBinding,
  type FederalTextVersion,
} from './federal-billstatus.js';
import {
  writeFederalInventory,
  writeFederalReceipt,
  type FederalReceipt,
  type ReceiptWriter,
} from './federal-billstatus-import.js';
import { parseFederalBillInventory } from './federal-bill-inventory-read.js';

type Reader = Pick<PrismaClient, '$queryRawUnsafe'>;
export type FederalGeneration = {
  refreshId?: string;
  congress: number;
  inventoryHash: string;
  archiveHashes: string[];
  archiveReceiptIds: string[];
  billIds: string[];
  billArchives: Map<string, string>;
  amendments: FederalAmendmentBinding[];
  excludedNonFYAmendments: number;
  amendmentListReceiptId: string;
};
export async function loadFederalGeneration(
  db: Reader,
  archiveHashes: string[],
  amendmentListHash: string,
  congress = 119,
  expectedAmendments = 7119,
  requireParents = true,
  refreshId?: string,
): Promise<FederalGeneration> {
  const hashes = [...new Set(archiveHashes)].sort();
  if (
    congress !== 119 ||
    hashes.length !== 8 ||
    hashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) ||
    !/^[a-f0-9]{64}$/.test(amendmentListHash) ||
    !Number.isInteger(expectedAmendments) ||
    expectedAmendments < 1 ||
    expectedAmendments > 100000
  )
    throw Error('FEDERAL_GENERATION_SCOPE_INVALID');
  const rows = await db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT r.id,r.source,r.scope,r.manifest,r.complete,r.observed_at AS "observedAt" FROM legal_source_receipt r
    WHERE r.source='fy26-federal-billstatus-archive' AND r.scope->>'archiveHash'=ANY($1::text[])
    AND EXISTS(SELECT 1 FROM legal_dataset_archive a WHERE a.content_hash=r.scope->>'archiveHash')`,
    hashes,
  );
  if (rows.length !== 8) throw Error('FEDERAL_GENERATION_ARCHIVES_INCOMPLETE');
  const types = new Set<string>(),
    allBills = new Set<string>(),
    billArchives = new Map<string, string>(),
    amendments = new Map<string, FederalAmendmentBinding>();
  for (const row of rows) {
    const scope = federalObject(row.scope),
      manifest = federalObject(row.manifest);
    if (
      !row.complete ||
      scope.fiscalYear !== 2026 ||
      scope.congress !== congress ||
      !hashes.includes(scope.archiveHash) ||
      !(FEDERAL_BILL_TYPES as readonly string[]).includes(scope.billType) ||
      types.has(scope.billType) ||
      manifest.schemaVersion !== 1 ||
      manifest.sourceListComplete !== true ||
      manifest.archiveHash !== scope.archiveHash ||
      manifest.congress !== congress ||
      manifest.billType !== scope.billType ||
      !Array.isArray(manifest.billIds) ||
      manifest.inspectedBills !== manifest.billIds.length ||
      !Array.isArray(manifest.eligibleBillIds) ||
      !Array.isArray(manifest.amendments)
    )
      throw Error('FEDERAL_GENERATION_ARCHIVE_INVALID');
    types.add(scope.billType);
    const pattern = new RegExp(`^${congress}-${scope.billType}-[1-9][0-9]*$`),
      local = new Set<string>();
    for (const id of manifest.billIds) {
      if (typeof id !== 'string' || !pattern.test(id) || allBills.has(id))
        throw Error('FEDERAL_GENERATION_BILL_INVALID');
      local.add(id);
      allBills.add(id);
    }
    for (const id of manifest.eligibleBillIds) {
      if (!local.has(id) || billArchives.has(id))
        throw Error('FEDERAL_GENERATION_ADMISSION_INVALID');
      billArchives.set(id, scope.archiveHash);
    }
    for (const a of manifest.amendments as FederalAmendmentBinding[]) {
      if (
        !new RegExp(`^${congress}-(?:hamdt|samdt)-[1-9][0-9]*$`).test(a.id) ||
        !local.has(a.billId) ||
        (a.amendedAmendmentId !== null &&
          !new RegExp(`^${congress}-(?:hamdt|samdt)-[1-9][0-9]*$`).test(a.amendedAmendmentId))
      )
        throw Error('FEDERAL_AMENDMENT_BINDING_INVALID');
      const old = amendments.get(a.id);
      if (old && JSON.stringify(old) !== JSON.stringify(a))
        throw Error('FEDERAL_AMENDMENT_BINDING_CONFLICT');
      amendments.set(a.id, a);
    }
  }
  if (amendments.size !== expectedAmendments)
    throw Error('FEDERAL_AMENDMENT_ENUMERATION_COUNT_MISMATCH');
  const listRows = await db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT r.id,r.scope,r.manifest,r.complete FROM legal_source_receipt r WHERE r.source='fy26-federal-amendment-list' AND r.scope->>'archiveHash'=$1
    AND EXISTS(SELECT 1 FROM legal_dataset_archive a WHERE a.content_hash=$1)`,
    amendmentListHash,
  );
  const expectedIds = [...amendments.keys()].sort();
  if (
    !listRows.length ||
    listRows.some(
      (row) =>
        !row.complete ||
        row.scope.congress !== congress ||
        row.scope.fiscalYear !== 2026 ||
        row.scope.archiveHash !== amendmentListHash ||
        row.manifest.schemaVersion !== 1 ||
        row.manifest.reportedCount !== expectedAmendments ||
        row.manifest.enumeratedCount !== expectedAmendments ||
        JSON.stringify(row.manifest.ids) !== JSON.stringify(expectedIds),
    )
  )
    throw Error('FEDERAL_AMENDMENT_EXACT_ENUMERATION_MISMATCH');
  // Identical retained list bytes can have several immutable proofs when valid page
  // boundaries change. Prefer a timestamp-bearing proof; a legacy proof must never
  // bypass freshness, and conflicting freshness proofs are not equivalent.
  const freshProofs = listRows.filter((row) => row.manifest.memberUpdates !== undefined);
  const proof = [...(freshProofs.length ? freshProofs : listRows)].sort((a, b) =>
    a.id.localeCompare(b.id),
  )[0]!;
  if (
    freshProofs.some(
      (row) =>
        !isDeepStrictEqual(row.manifest.memberUpdates, proof.manifest.memberUpdates) ||
        JSON.stringify(Object.keys(federalObject(row.manifest.memberUpdates)).sort()) !==
          JSON.stringify(expectedIds),
    )
  )
    throw Error('FEDERAL_AMENDMENT_SOURCE_MOVED');
  // Every nested amendment must terminate at the same direct bill; unknown/cycles are never exclusions.
  for (const binding of amendments.values()) {
    if (
      proof.manifest.memberUpdates &&
      (!binding.providerUpdatedAt ||
        new Date(proof.manifest.memberUpdates[binding.id]).getTime() !==
          new Date(binding.providerUpdatedAt).getTime())
    )
      throw Error('FEDERAL_AMENDMENT_SOURCE_MOVED');
    const visited = new Set<string>([binding.id]);
    let parent = binding.amendedAmendmentId;
    while (parent) {
      const ancestor = amendments.get(parent);
      if (!ancestor || ancestor.billId !== binding.billId || visited.has(parent))
        throw Error('FEDERAL_AMENDMENT_PARENT_UNRESOLVED');
      visited.add(parent);
      parent = ancestor.amendedAmendmentId;
    }
  }
  const billIds = [...billArchives.keys()].sort();
  const admitted = requireParents
    ? await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT b.id FROM congress_bill b WHERE b.congress=$1 AND ${FEDERAL_FY26_SQL} ORDER BY b.id`,
        congress,
      )
    : [];
  // A completed older generation remains usable when daily sync admits newer parents.
  const admittedIds = new Set(admitted.map((b) => b.id));
  if (requireParents && billIds.some((id) => !admittedIds.has(id)))
    throw Error('FEDERAL_GENERATION_CANONICAL_ADMISSION_MISMATCH');
  return {
    ...(refreshId ? { refreshId } : {}),
    congress,
    inventoryHash: federalHash(JSON.stringify([congress, hashes, amendmentListHash])),
    archiveHashes: hashes,
    archiveReceiptIds: rows.map((r) => r.id).sort(),
    billIds,
    billArchives,
    amendmentListReceiptId: proof.id,
    amendments: [...amendments.values()]
      .filter((a) => billArchives.has(a.billId))
      .sort((a, b) => a.id.localeCompare(b.id)),
    excludedNonFYAmendments: [...amendments.values()].filter((a) => !billArchives.has(a.billId))
      .length,
  };
}

export type FederalJsonFetch = (url: string) => Promise<unknown>;
/** Full strict pagination: a truncated/moving list is not an authoritative empty inventory. */
export async function fetchFederalVersionList(
  providerDocumentId: string,
  kind: 'text' | 'amendment',
  apiKey: string,
  fetchJson: FederalJsonFetch = (url) => fetchCongressJson(url),
) {
  const match = /^(\d+)-([a-z]+)-([1-9][0-9]*)$/.exec(providerDocumentId);
  if (
    !match ||
    !(kind === 'text' ? (FEDERAL_BILL_TYPES as readonly string[]) : ['hamdt', 'samdt']).includes(
      match[2]!,
    )
  )
    throw Error('FEDERAL_API_IDENTITY_INVALID');
  const base = `https://api.congress.gov/v3/${kind === 'text' ? 'bill' : 'amendment'}/${match[1]}/${match[2]}/${match[3]}/text`;
  let next: string | null = `${base}?format=json&limit=250&offset=0`,
    expected: number | null = null;
  const seen = new Set<string>(),
    versions: unknown[] = [];
  let singlePageJson: string | undefined;
  while (next) {
    const url = new URL(next);
    if (
      url.origin !== 'https://api.congress.gov' ||
      url.pathname !== new URL(base).pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('FEDERAL_API_CONTINUATION_SCOPE_MISMATCH');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(offset) || offset !== versions.length || seen.has(String(offset)))
      throw Error('FEDERAL_API_CONTINUATION_OFFSET_MISMATCH');
    seen.add(String(offset));
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '250');
    const payload = federalObject(await fetchJson(url.href)),
      pagination = federalObject(payload.pagination);
    if (
      !Array.isArray(payload.textVersions) ||
      !Number.isInteger(pagination.count) ||
      pagination.count < 0 ||
      pagination.count > 10000 ||
      (expected !== null && expected !== pagination.count)
    )
      throw Error('FEDERAL_API_TEXT_LIST_INCOMPLETE');
    expected = pagination.count;
    if (seen.size === 1)
      singlePageJson = JSON.stringify({ pagination, textVersions: payload.textVersions });
    versions.push(...payload.textVersions);
    if (versions.length > expected!) throw Error('FEDERAL_API_TEXT_LIST_COUNT_MISMATCH');
    next = pagination.next ?? null;
    if (next !== null && (typeof next !== 'string' || !payload.textVersions.length))
      throw Error('FEDERAL_API_TEXT_LIST_INCOMPLETE');
  }
  if (versions.length !== expected) throw Error('FEDERAL_API_TEXT_LIST_INCOMPLETE');
  if (
    seen.size === 1 &&
    new Set(versions.map((entry) => JSON.stringify(entry))).size < versions.length
  ) {
    const exactDuplicateProof: FederalExactDuplicateProof = {
      rule: 'exact-json-single-page-v1',
      sourceUrl: base,
      offset: 0,
      pageCount: 1,
      pageJson: singlePageJson!,
      pageSha256: federalHash(singlePageJson!),
    };
    return {
      versions: replayFederalExactDuplicates(providerDocumentId, kind, exactDuplicateProof)
        .versions,
      exactDuplicateProof,
    };
  }
  return { versions: normalizeFederalVersions(providerDocumentId, kind, versions) };
}

export async function loadFederalInventories(
  db: Reader,
  generation: FederalGeneration,
): Promise<FederalReceipt[]> {
  return db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT id,source,scope,manifest,complete,observed_at AS "observedAt" FROM legal_source_receipt
    WHERE source='fy26-federal-provider-inventory' AND scope->>'fiscalYear'='2026' AND scope->>'congress'=$1
    AND (scope->>'archiveHash'=ANY($2::text[]) OR scope->>'inventoryHash'=$3) ORDER BY observed_at DESC,id DESC`,
    String(generation.congress),
    generation.archiveHashes,
    generation.inventoryHash,
  );
}
export function selectFederalInventories(
  receipts: FederalReceipt[],
  generation: FederalGeneration,
) {
  const selected = new Map<string, FederalReceipt>();
  const amendmentParents = new Map(generation.amendments.map((a) => [a.id, a.billId]));
  for (const receipt of receipts) {
    const m = federalObject(receipt.manifest),
      scope = federalObject(receipt.scope);
    if (generation.refreshId && scope.refreshId !== generation.refreshId) continue;
    if (!generation.billArchives.has(scope.billId) || !['text', 'amendment'].includes(m.kind))
      continue;
    if (
      m.kind === 'text'
        ? m.providerDocumentId !== scope.billId ||
          scope.archiveHash !== generation.billArchives.get(scope.billId)
        : amendmentParents.get(m.providerDocumentId) !== scope.billId ||
          scope.inventoryHash !== generation.inventoryHash
    )
      continue;
    const key = `${m.kind}:${m.providerDocumentId}`;
    // A later failed attempt cannot replace a qualified immutable list.
    if (!selected.has(key) || (!selected.get(key)!.complete && receipt.complete))
      selected.set(key, receipt);
  }
  return selected;
}
export async function enumerateFederalInventories(
  db: PrismaClient,
  generation: FederalGeneration,
  options: {
    limit: number;
    apiKey: string;
    fetchJson: FederalJsonFetch;
    check?: () => void;
    reuse?: (
      task: { kind: 'text' | 'amendment'; id: string; billId: string; updated: string | null },
      scope: Record<string, unknown>,
    ) => Promise<boolean>;
  },
) {
  const selected = selectFederalInventories(
    await loadFederalInventories(db, generation),
    generation,
  );
  const tasks = [
    ...generation.billIds
      .filter((id) => !selected.get(`text:${id}`)?.complete)
      .map((id) => ({
        kind: 'text' as const,
        id,
        billId: id,
        updated: selected.get(`text:${id}`)?.manifest.providerUpdatedAt ?? null,
      })),
    ...generation.amendments
      .filter((a) => !selected.get(`amendment:${a.id}`)?.complete)
      .map((a) => ({
        kind: 'amendment' as const,
        id: a.id,
        billId: a.billId,
        updated: a.providerUpdatedAt,
      })),
  ];
  // Missing bulk import must be completed before HTTP fallback; it is not 10,000 missing API lists.
  if (generation.billIds.some((id) => !selected.has(`text:${id}`)))
    throw Error('FEDERAL_BULK_IMPORT_NOT_FINISHED');
  const source = `fy26-federal-inventory:${generation.inventoryHash}`;
  await db.$executeRawUnsafe(
    'INSERT INTO federal_evidence_checkpoint(source,status,cursor_jsonb) VALUES($1,\'running\',\'{"after":""}\'::jsonb) ON CONFLICT DO NOTHING',
    source,
  );
  const checkpoints = await db.$queryRawUnsafe<Array<{ cursor: { after: string } }>>(
    'SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=$1',
    source,
  );
  const after = checkpoints[0]?.cursor.after;
  if (typeof after !== 'string') throw Error('FEDERAL_INVENTORY_CHECKPOINT_INVALID');
  tasks.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const ordered = [
    ...tasks.filter((t) => `${t.kind}:${t.id}` > after),
    ...tasks.filter((t) => `${t.kind}:${t.id}` <= after),
  ];
  let processed = 0,
    failed = 0,
    capped = false;
  for (const task of ordered.slice(0, options.limit)) {
    options.check?.();
    const scope = {
      fiscalYear: 2026,
      congress: generation.congress,
      billId: task.billId,
      ...(generation.refreshId ? { refreshId: generation.refreshId } : {}),
      ...(task.kind === 'text'
        ? { archiveHash: generation.billArchives.get(task.billId)! }
        : { inventoryHash: generation.inventoryHash }),
    };
    try {
      if (!(await options.reuse?.(task, scope))) {
        const list = await fetchFederalVersionList(
          task.id,
          task.kind,
          options.apiKey,
          options.fetchJson,
        );
        await writeFederalInventory(
          db,
          scope,
          {
            kind: task.kind,
            providerDocumentId: task.id,
            providerUpdatedAt: task.updated,
            ...list,
            ...(task.kind === 'amendment' ? { amendmentId: task.id } : {}),
          },
          true,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'FEDERAL_INVENTORY_FAILED';
      if (message === 'CONGRESS_REQUEST_CAP_REACHED' || message === 'FEDERAL_REFRESH_DEADLINE') {
        capped = true;
        break;
      }
      if (message.startsWith('FEDERAL_WRITER_')) throw error;
      failed++;
      await writeFederalReceipt(
        db,
        'fy26-federal-inventory-attempt',
        scope,
        {
          schemaVersion: 1,
          kind: task.kind,
          providerDocumentId: task.id,
          status: 'failed',
          error: message.replace(/api_key=[^&\s]+/gi, 'api_key=[REDACTED]').slice(0, 500),
          attemptedAt: new Date().toISOString(),
        },
        false,
      );
    }
    processed++;
    await db.$executeRawUnsafe(
      "UPDATE federal_evidence_checkpoint SET cursor_jsonb=$2::jsonb,status='running',updated_at=clock_timestamp() WHERE source=$1",
      source,
      JSON.stringify({ after: `${task.kind}:${task.id}` }),
    );
  }
  const remaining = tasks.length - processed + failed;
  if (!remaining)
    await db.$executeRawUnsafe(
      "UPDATE federal_evidence_checkpoint SET status='completed',completed_at=clock_timestamp() WHERE source=$1",
      source,
    );
  return { processed, failed, capped, remaining, complete: remaining === 0 };
}

export async function finalizeFederalDiscovery(
  db: ReceiptWriter,
  generation: FederalGeneration,
  refreshedAt?: string,
) {
  const selected = selectFederalInventories(
    await loadFederalInventories(db as Reader, generation),
    generation,
  );
  const required = [
    ...generation.billIds.map((id) => `text:${id}`),
    ...generation.amendments.map((a) => `amendment:${a.id}`),
  ];
  if (required.some((key) => !selected.get(key)?.complete))
    throw Error('FEDERAL_DISCOVERY_CHILD_INVENTORY_INCOMPLETE');
  const discovery = {
    receiptId: '',
    congress: generation.congress,
    billIds: generation.billIds,
    requiredInventoryReceiptIds: [],
    observedAt: new Date(),
  };
  for (const key of required)
    if (!parseFederalBillInventory(selected.get(key)!, discovery))
      throw Error('FEDERAL_DISCOVERY_CHILD_INVENTORY_INVALID');
  const admitted = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT b.id FROM congress_bill b WHERE b.congress=$1 AND ${FEDERAL_FY26_SQL} ORDER BY b.id`,
    generation.congress,
  );
  if (
    JSON.stringify(admitted.map((b) => b.id).sort()) !==
    JSON.stringify([...generation.billIds].sort())
  )
    throw Error('FEDERAL_DISCOVERY_CANONICAL_ADMISSION_MISMATCH');
  const requiredInventoryReceiptIds = required.map((key) => selected.get(key)!.id).sort();
  const id = await writeFederalReceipt(
    db,
    'fy26-federal-discovery',
    { fiscalYear: 2026, congress: generation.congress, inventoryHash: generation.inventoryHash },
    {
      schemaVersion: 1,
      ...(refreshedAt ? { refreshedAt } : {}),
      billIds: generation.billIds,
      requiredInventoryReceiptIds,
      archiveReceiptIds: generation.archiveReceiptIds,
      amendmentListReceiptId: generation.amendmentListReceiptId,
      sourceListComplete: true,
      amendmentEnumerationComplete: true,
      amendmentParentsResolved: true,
      unresolvedAmendments: 0,
      excludedTreatyAmendments: 0,
      excludedNonFYAmendments: generation.excludedNonFYAmendments,
    },
    true,
  );
  return {
    receiptId: id,
    bills: generation.billIds.length,
    amendments: generation.amendments.length,
    inventories: requiredInventoryReceiptIds.length,
    complete: true,
  };
}
