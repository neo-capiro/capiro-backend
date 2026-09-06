import {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  type MeriCitation,
} from '@capiro/shared';
import type {
  LedgerEntry,
  MeriEvidenceManifest,
  MeriGovernedTurnContext,
} from '@capiro/meriv2-core';

/** The controller authenticates this context before putting it in request-local storage. */
export function seedMeriContextEvidence(governed: MeriGovernedTurnContext | null): {
  citations: MeriCitation[];
  ledgerEntries: LedgerEntry[];
  citationPrompt: string;
} {
  const envelope = governed?.evidence;
  if (!envelope?.records.length) return { citations: [], ledgerEntries: [], citationPrompt: '' };
  const citations = extractCitationsFromToolResult(
    'context_plane',
    envelope,
    1,
    envelope.records.length,
  );
  const citationPrompt = formatCitationsForPrompt(citations);
  // This is a prefetched source result, not a tool execution. Preserve the
  // exact projected evidence the API placed in the model's governed prompt.
  const result = { ...envelope, origin: 'initial_context' as const };
  return {
    citations,
    citationPrompt,
    ledgerEntries: [
      {
        tool: 'context_plane',
        serialized: `${citationPrompt}\n\n${JSON.stringify(result)}`,
        result,
        rowCount: envelope.records.length,
      },
    ],
  };
}

export function meriEvidenceManifest(
  governed: MeriGovernedTurnContext | null,
  citations: readonly MeriCitation[],
  ledgerEntries: readonly LedgerEntry[] = [],
): MeriEvidenceManifest {
  const envelope = governed?.evidence;
  const projected = new Map(envelope?.records.map((record) => [record.recordId, record]) ?? []);
  const toolTruncation = new Map<string, boolean | null>();
  for (const entry of ledgerEntries) {
    if (entry.tool === 'context_plane') continue;
    const result = record(entry.result);
    const projection = record(result?.projection);
    const status =
      projection?.truncated === true || result?.truncated === true
        ? true
        : projection?.truncated === false || result?.truncated === false
          ? false
          : null;
    const previous = toolTruncation.get(entry.tool);
    // Any clipped call remains a disclosed gap even if a later read succeeds.
    toolTruncation.set(
      entry.tool,
      previous === true || status === true
        ? true
        : previous === null || status === null
          ? null
          : status,
    );
  }
  return {
    version: 1,
    packetId: governed?.contextPacket.packetId ?? null,
    sourceRecordCount: envelope?.sourceRecordCount ?? 0,
    projectedRecordCount: envelope?.projectedRecordCount ?? 0,
    truncated:
      envelope?.truncated === true || [...toolTruncation.values()].some((value) => value === true),
    sources: citations.map((source) => ({
      id: source.id,
      tool: source.tool,
      origin: source.tool === 'context_plane' ? 'initial_context' : 'tool',
      truncated:
        source.tool === 'context_plane'
          ? (projected.get(source.id)?.projection.truncated ?? null)
          : (toolTruncation.get(source.tool) ?? null),
    })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
