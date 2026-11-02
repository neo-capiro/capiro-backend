import type { BillJurisdictionInventory } from './state-bill-inventory-read.js';

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };
type Receipt = {
  id: string;
  scope: unknown;
  manifest: unknown;
  complete: boolean;
  observedAt: Date | string;
};
export type FederalExpectedVersion = {
  billId: string;
  session: string;
  kind: 'text' | 'amendment';
  providerDocumentId: string;
  versionId: string | null;
  version: string;
  packageId: string | null;
  collection: 'BILLS' | 'AMENDMENTS' | 'PLAW';
  versionCode: string | null;
  sourceUrls: string[];
  receiptId: string;
  providerUpdatedAt: string | null;
};
export type FederalBillDiscovery = {
  receiptId: string;
  congress: number;
  billIds: string[];
  requiredInventoryReceiptIds: string[];
  observedAt: Date | string;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const bounded = (value: unknown, max = 200): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f]/.test(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const FEDERAL_BILL_DISCOVERY_SQL = `SELECT id,scope,manifest,complete,observed_at AS "observedAt" FROM legal_source_receipt
 WHERE source='fy26-federal-discovery' AND scope->>'fiscalYear'='2026' AND complete ORDER BY observed_at DESC,id DESC LIMIT 1`;
export const FEDERAL_BILL_INVENTORY_SQL = `SELECT id,scope,manifest,complete,observed_at AS "observedAt" FROM legal_source_receipt
 WHERE source='fy26-federal-provider-inventory' AND id=ANY($1::text[])`;

export function parseFederalBillDiscovery(
  receipt: Receipt | undefined,
): FederalBillDiscovery | null {
  if (!receipt?.complete) return null;
  const scope = object(receipt.scope),
    manifest = object(receipt.manifest);
  if (
    !scope ||
    !manifest ||
    scope.fiscalYear !== 2026 ||
    !count(scope.congress) ||
    scope.congress < 1 ||
    manifest.schemaVersion !== 1 ||
    manifest.sourceListComplete !== true ||
    manifest.amendmentEnumerationComplete !== true ||
    manifest.amendmentParentsResolved !== true ||
    manifest.unresolvedAmendments !== 0 ||
    !count(manifest.excludedTreatyAmendments) ||
    !count(manifest.excludedNonFYAmendments) ||
    !Array.isArray(manifest.billIds) ||
    manifest.billIds.length > 50000 ||
    !Array.isArray(manifest.requiredInventoryReceiptIds) ||
    manifest.requiredInventoryReceiptIds.length > 100000
  )
    return null;
  const billPattern = new RegExp(
    `^${scope.congress}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)-[1-9][0-9]*$`,
  );
  if (
    manifest.billIds.some((id) => !bounded(id) || !billPattern.test(id)) ||
    new Set(manifest.billIds).size !== manifest.billIds.length ||
    manifest.requiredInventoryReceiptIds.some((id) => !bounded(id)) ||
    new Set(manifest.requiredInventoryReceiptIds).size !==
      manifest.requiredInventoryReceiptIds.length
  )
    return null;
  return {
    receiptId: receipt.id,
    congress: scope.congress,
    billIds: manifest.billIds as string[],
    requiredInventoryReceiptIds: manifest.requiredInventoryReceiptIds as string[],
    observedAt: receipt.observedAt,
  };
}

export function parseFederalBillInventory(
  receipt: Receipt,
  discovery: FederalBillDiscovery,
  admittedBills: ReadonlySet<string> = new Set(discovery.billIds),
): FederalExpectedVersion[] | null {
  const scope = object(receipt.scope),
    manifest = object(receipt.manifest);
  if (
    !receipt.complete ||
    !scope ||
    !manifest ||
    scope.fiscalYear !== 2026 ||
    scope.congress !== discovery.congress ||
    typeof scope.billId !== 'string' ||
    !admittedBills.has(scope.billId) ||
    manifest.schemaVersion !== 1 ||
    !['text', 'amendment'].includes(String(manifest.kind)) ||
    !bounded(manifest.providerDocumentId) ||
    !Array.isArray(manifest.versions) ||
    !count(manifest.reportedCount) ||
    manifest.reportedCount !== manifest.enumeratedCount ||
    manifest.reportedCount !== manifest.versions.length
  )
    return null;
  const kind = manifest.kind as 'text' | 'amendment';
  if (
    kind === 'text'
      ? manifest.providerDocumentId !== scope.billId
      : !new RegExp(`^${discovery.congress}-(?:hamdt|samdt)-[1-9][0-9]*$`).test(
          manifest.providerDocumentId,
        )
  )
    return null;
  if (
    manifest.providerUpdatedAt !== null &&
    manifest.providerUpdatedAt !== undefined &&
    !bounded(manifest.providerUpdatedAt)
  )
    return null;
  const common = {
    billId: scope.billId,
    session: String(discovery.congress),
    kind,
    providerDocumentId: manifest.providerDocumentId,
    collection: kind === 'text' ? ('BILLS' as const) : ('AMENDMENTS' as const),
    receiptId: receipt.id,
    providerUpdatedAt:
      typeof manifest.providerUpdatedAt === 'string' ? manifest.providerUpdatedAt : null,
  };
  const versions: FederalExpectedVersion[] = [],
    seen = new Set<string>();
  for (const value of manifest.versions) {
    const version = object(value);
    if (
      !version ||
      !bounded(version.versionId) ||
      seen.has(version.versionId) ||
      !bounded(version.type) ||
      !Array.isArray(version.formats) ||
      !(kind === 'text' ? ['BILLS', 'PLAW'] : ['AMENDMENTS']).includes(
        String(version.collection),
      ) ||
      (version.packageId !== null && !bounded(version.packageId)) ||
      (version.versionCode !== null && !bounded(version.versionCode)) ||
      (version.sourceUrl !== null && !bounded(version.sourceUrl, 3000))
    )
      return null;
    seen.add(version.versionId);
    const urls: string[] = [];
    for (const value of version.formats) {
      const format = object(value);
      if (
        !format ||
        !bounded(format.type) ||
        !bounded(format.url, 3000) ||
        !/^https?:\/\//.test(format.url)
      )
        return null;
      urls.push(format.url);
    }
    if (version.sourceUrl) urls.push(version.sourceUrl as string);
    versions.push({
      ...common,
      collection: version.collection as FederalExpectedVersion['collection'],
      versionId: version.versionId,
      version: version.type,
      packageId: version.packageId as string | null,
      versionCode: version.versionCode as string | null,
      sourceUrls: [...new Set(urls)],
    });
  }
  // An explicitly empty provider list is a known empty inventory, not a failed extraction.
  return versions.length
    ? versions
    : [
        {
          ...common,
          versionId: null,
          version: 'no_published_versions',
          packageId: null,
          versionCode: null,
          sourceUrls: [],
        },
      ];
}

export async function loadPinnedFederalInventory(db: Reader) {
  const discovery = parseFederalBillDiscovery(
    (await db.$queryRawUnsafe<Receipt[]>(FEDERAL_BILL_DISCOVERY_SQL))[0],
  );
  if (!discovery)
    return {
      discovery: null,
      inventory: null,
      versions: [] as FederalExpectedVersion[],
      missingReceiptIds: [] as string[],
    };
  const receipts = discovery.requiredInventoryReceiptIds.length
    ? await db.$queryRawUnsafe<Receipt[]>(
        FEDERAL_BILL_INVENTORY_SQL,
        discovery.requiredInventoryReceiptIds,
      )
    : [];
  const missingReceiptIds: string[] = [],
    versions: FederalExpectedVersion[] = [],
    identities = new Set<string>(),
    textBills = new Set<string>();
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt])),
    admittedBills = new Set(discovery.billIds);
  for (const id of discovery.requiredInventoryReceiptIds) {
    const receipt = byId.get(id),
      parsed = receipt ? parseFederalBillInventory(receipt, discovery, admittedBills) : null;
    const identity = parsed?.[0]
      ? `${parsed[0].billId}:${parsed[0].kind}:${parsed[0].providerDocumentId}`
      : null;
    if (!parsed || !identity || identities.has(identity)) {
      missingReceiptIds.push(id);
      continue;
    }
    identities.add(identity);
    if (parsed[0]!.kind === 'text') textBills.add(parsed[0]!.billId);
    versions.push(...parsed);
  }
  const missingTextBills = discovery.billIds.filter((billId) => !textBills.has(billId));
  for (const billId of missingTextBills)
    versions.push({
      billId,
      session: String(discovery.congress),
      kind: 'text',
      providerDocumentId: billId,
      versionId: null,
      version: 'inventory_pending',
      packageId: null,
      collection: 'BILLS',
      versionCode: null,
      sourceUrls: [],
      receiptId: '',
      providerUpdatedAt: null,
    });
  const known = missingReceiptIds.length === 0 && missingTextBills.length === 0;
  const inventory: BillJurisdictionInventory = {
    jurisdiction: 'US',
    known,
    expectedSessions: 1,
    qualifiedSessions: known ? 1 : 0,
    missingSessions: known ? [] : [String(discovery.congress)],
  };
  return { discovery, inventory, versions, missingReceiptIds, missingTextBills };
}
