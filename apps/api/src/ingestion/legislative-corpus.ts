type Expected = { kind: string; providerId: number; providerHash: string | null };
type BillInventory = {
  billId: string;
  providerChangeHash: string | null;
  sourceCheckedAt: string | null;
  sourceListComplete: boolean;
  expected: Expected[];
};
type Extracted = {
  documentId: string;
  billId: string;
  kind: string;
  providerId: string;
  providerHash: string | null;
  revision: string;
  parserVersion: string | null;
  complete: boolean;
  isCurrent: boolean;
};
/** Completeness is restricted to the explicit bill inventory, never a whole session inferred from stored rows. */
export function qualifyLegislativeCorpus(
  selectedBillIds: string[],
  inventories: BillInventory[],
  documents: Extracted[],
) {
  if (
    !selectedBillIds.length ||
    selectedBillIds.length > 30 ||
    new Set(selectedBillIds).size !== selectedBillIds.length
  )
    throw Error('BOUNDED_DISTINCT_BILL_SELECTION_REQUIRED');
  const gaps: string[] = [],
    entries: Array<Record<string, unknown>> = [];
  for (const billId of selectedBillIds) {
    const inventory = inventories.find((i) => i.billId === billId);
    if (
      !inventory ||
      !inventory.sourceListComplete ||
      !inventory.sourceCheckedAt ||
      !inventory.providerChangeHash
    ) {
      gaps.push('SOURCE_LIST_NOT_QUALIFIED:' + billId);
      continue;
    }
    if (inventory.expected.length > 500) throw Error('CORPUS_DOCUMENT_BUDGET_EXCEEDED');
    for (const expected of inventory.expected) {
      const found = documents.filter(
        (d) =>
          d.billId === billId &&
          d.kind === expected.kind &&
          d.providerId === String(expected.providerId) &&
          d.isCurrent,
      );
      const matched = found.find(
        (d) => d.complete && expected.providerHash && d.providerHash === expected.providerHash,
      );
      const status = matched
        ? 'extracted'
        : found.length
          ? 'partial_or_source_hash_changed'
          : 'missing';
      if (!matched)
        gaps.push(
          status.toUpperCase() + ':' + billId + ':' + expected.kind + ':' + expected.providerId,
        );
      entries.push({
        billId,
        ...expected,
        status,
        documentId: matched?.documentId ?? null,
        revision: matched?.revision ?? null,
        extractorVersion: matched?.parserVersion ?? null,
        retainedRevisionIds: documents
          .filter(
            (d) =>
              d.billId === billId &&
              d.kind === expected.kind &&
              d.providerId === String(expected.providerId),
          )
          .map((d) => d.documentId),
      });
    }
  }
  return {
    version: 'selected-bill-inventory-v1',
    selectedBillIds,
    scope: 'explicit_bill_ids_and_provider_listed_documents',
    entries,
    gaps,
    complete: !gaps.length,
    inventoryVersions: inventories.map((i) => ({
      billId: i.billId,
      providerChangeHash: i.providerChangeHash,
      observedAt: i.sourceCheckedAt,
    })),
    sessionWideComplete: false,
  };
}
