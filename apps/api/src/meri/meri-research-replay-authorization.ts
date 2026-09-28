import { researchJsonSha256 } from './meri-research-durable-result.js';

const SUPPORTED_OWNER_TOOLS = new Set(['search_memory', 'read_client_documents']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rows(value: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(value.records)
    ? value.records.map(record).filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
}

function memoryProof(value: unknown): string[] | null {
  const root = record(value);
  if (!root || root.tool !== 'search_memory') return null;
  const proofs: string[] = [];
  for (const row of rows(root)) {
    const payload = record(row.payload);
    const provenance = record(row.provenance);
    const content = record(payload?.content);
    const recordId = typeof row.recordId === 'string' ? row.recordId : null;
    const version = typeof provenance?.sourceVersion === 'string' ? provenance.sourceVersion : null;
    const contentHash =
      typeof content?.hash === 'string'
        ? content.hash
        : typeof provenance?.contentHash === 'string'
          ? provenance.contentHash
          : null;
    if (!recordId || (!version && !contentHash)) return null;
    proofs.push(
      researchJsonSha256({
        recordId,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
        version,
        contentHash,
        clientId: typeof payload?.clientId === 'string' ? payload.clientId : null,
      }),
    );
  }
  return proofs.sort();
}

function documentProof(value: unknown): string[] | null {
  const root = record(value);
  if (!root || root.tool !== 'read_client_documents') return null;
  const document = record(root.document);
  if (
    !document ||
    typeof document.id !== 'string' ||
    typeof document.contentHash !== 'string'
  ) {
    // Listings carry no owner content version and therefore cannot authorize replay.
    return null;
  }
  const proofs = rows(root).map((row) => {
    const provenance = record(row.provenance);
    return researchJsonSha256({
      recordId: row.recordId,
      documentId: document.id,
      contentHash: document.contentHash,
      sectionHash: provenance?.sectionHash,
      section: provenance?.section,
      characterStart: provenance?.characterStart,
      characterEnd: provenance?.characterEnd,
    });
  });
  return [
    researchJsonSha256({
      documentId: document.id,
      contentHash: document.contentHash,
      clientId: root.clientId,
    }),
    ...proofs,
  ].sort();
}

export function supportsDurableOwnerReauthorization(tool: string): boolean {
  return SUPPORTED_OWNER_TOOLS.has(tool);
}

/** Compare only current owner identity/version evidence, never old coverage flags. */
export function currentOwnerResultAuthorizesReplay(
  tool: string,
  savedResult: unknown,
  currentResult: unknown,
): boolean {
  const project = tool === 'search_memory'
    ? memoryProof
    : tool === 'read_client_documents'
      ? documentProof
      : null;
  if (!project) return false;
  const saved = project(savedResult);
  const current = project(currentResult);
  return Boolean(saved && current && researchJsonSha256(saved) === researchJsonSha256(current));
}
