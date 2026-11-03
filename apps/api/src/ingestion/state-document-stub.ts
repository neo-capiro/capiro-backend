import type { LegiscanBill, LegiscanDocumentFormat } from '../external/legiscan/legiscan.client.js';

export interface StateDocumentStub {
  kind: 'text' | 'amendment' | 'supplement';
  providerId: number;
  providerHash: string | null;
  stateUrl?: string | null;
  url?: string | null;
  mime?: string | null;
  size?: number | null;
  date?: string | null;
  versionType?: string | null;
  title?: string | null;
  format?: LegiscanDocumentFormat;
}

/** Preserve original primary-format metadata; alternate-format hashes are not
 * interchangeable with the frozen primary document identity. */
export function stateDocumentStubs(
  raw: Pick<LegiscanBill, 'texts' | 'amendments' | 'supplements'>,
): StateDocumentStub[] {
  const metadata = (doc: any) => ({
    stateUrl: doc.state_link ?? null,
    url: doc.url ?? null,
    mime: doc.mime ?? null,
    date: doc.date ?? null,
    versionType: doc.type ?? null,
    title: doc.title ?? doc.description ?? null,
  });
  return [
    ...(raw.texts ?? []).map((doc) => ({
      kind: 'text' as const,
      providerId: doc.doc_id,
      providerHash: doc.text_hash ?? null,
      size: doc.text_size ?? null,
      ...metadata(doc),
    })),
    ...(raw.amendments ?? []).map((doc: any) => ({
      kind: 'amendment' as const,
      providerId: doc.amendment_id,
      providerHash: doc.amendment_hash ?? null,
      size: doc.amendment_size ?? null,
      ...metadata(doc),
    })),
    ...(raw.supplements ?? []).map((doc: any) => ({
      kind: 'supplement' as const,
      providerId: doc.supplement_id,
      providerHash: doc.supplement_hash ?? null,
      size: doc.supplement_size ?? null,
      ...metadata(doc),
    })),
  ];
}

export function validDocumentIdentity(stub: StateDocumentStub): boolean {
  return (
    ['text', 'amendment', 'supplement'].includes(stub.kind) &&
    Number.isSafeInteger(stub.providerId) &&
    stub.providerId > 0 &&
    typeof stub.providerHash === 'string' &&
    /^[a-f\d]{32}$/i.test(stub.providerHash)
  );
}

/** Earlier primary-byte identities survive current-list refreshes and URL reuse. */
export function mergeDocumentStubs(
  previous: unknown,
  incoming: StateDocumentStub[],
): StateDocumentStub[] {
  const rows = Array.isArray(previous) ? previous : [];
  const byIdentity = new Map<string, StateDocumentStub>();
  for (const stub of [...rows, ...incoming]) {
    if (
      !stub ||
      !['text', 'amendment', 'supplement'].includes(stub.kind) ||
      !Number.isSafeInteger(stub.providerId)
    )
      continue;
    const key = JSON.stringify([
      stub.kind,
      stub.providerId,
      stub.providerHash,
      stub.format?.primaryProviderHash ?? null,
    ]);
    if (!byIdentity.has(key)) byIdentity.set(key, stub);
  }
  return [...byIdentity.values()];
}
