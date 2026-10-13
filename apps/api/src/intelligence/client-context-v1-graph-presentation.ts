import type { Prisma } from '@prisma/client';
import type { ClientContextGraphWalkRow } from './client-context-v1-graph.js';

type GraphClient = Prisma.ClientGetPayload<{ select: { id: true; name: true; sectorTag: true } }>;

export function kindToUiType(
  kind: string,
): 'client' | 'registrant' | 'lobbyist' | 'contractor' | 'bill' | 'pac' | 'agency' {
  switch (kind) {
    case 'client':
      return 'client';
    case 'lda_client':
    case 'lda_registrant':
    case 'registrant':
      // LDA clients/registrants are both org-like; render with the
      // registrant chrome since they share the "lobbying firm" feel.
      return 'registrant';
    case 'lda_lobbyist':
    case 'lobbyist':
    case 'member':
    case 'candidate':
      // People, legislators, candidates, registered lobbyists.
      return 'lobbyist';
    case 'federal_contractor':
    case 'contractor':
      return 'contractor';
    case 'bill':
    case 'congress_bill':
    case 'subject':
    case 'policy_area':
    case 'lda_issue_code':
      // Bill-adjacent topical nodes share the bill chrome.
      return 'bill';
    case 'fec_committee':
    case 'fec_contribution':
    case 'employer':
    case 'pac':
      return 'pac';
    case 'capability':
    case 'program_element':
    case 'committee':
    case 'hearing':
    case 'agency':
    case 'docket':
    case 'fr_document':
    default:
      return 'agency';
  }
}

export function prettyLabel(
  kind: string,
  id: string,
  clientLabel: string,
  labelByNodeKey: Map<string, string>,
) {
  if (kind === 'client') return clientLabel;
  // Use the batch-resolved name if we have one.
  const resolved = labelByNodeKey.get(`${kind}:${id}`);
  if (resolved) {
    return resolved.length > 96 ? `${resolved.slice(0, 96)}…` : resolved;
  }
  // Some kinds carry meaningful values as their id (bill numbers,
  // committee codes, issue code names), let those pass through
  // verbatim.
  if (
    kind === 'bill' ||
    kind === 'subject' ||
    kind === 'policy_area' ||
    kind === 'committee' ||
    kind === 'agency' ||
    kind === 'employer' ||
    kind === 'candidate' ||
    kind === 'member' ||
    kind === 'program_element' ||
    kind === 'foreign_principal' ||
    kind === 'sec_company'
  ) {
    return id.length > 96 ? `${id.slice(0, 96)}…` : id;
  }
  // Last resort, opaque ID. Prefix with kind so it's at least
  // legible as "(lda_client) 189497" rather than a naked number.
  return `(${kind.replace(/_/g, ' ')}) ${id.length > 24 ? id.slice(0, 24) + '…' : id}`;
}

export function buildKnowledgeGraphMaps(
  client: GraphClient | null,
  clientLabel: string,
  centerNodeId: string,
  filteredWalkRows: ClientContextGraphWalkRow[],
  labelByNodeKey: Map<string, string>,
) {
  const nodeMap = new Map<
    string,
    { id: string; type: string; label: string; metadata: Record<string, unknown> }
  >();

  const edgeMap = new Map<
    string,
    { source: string; target: string; type: string; label: string }
  >();

  nodeMap.set(centerNodeId, {
    id: centerNodeId,
    type: 'client',
    label: clientLabel,
    metadata: { sectorTag: client?.sectorTag ?? null },
  });

  const upsertNode = (kind: string, id: string, extras: Record<string, unknown> = {}) => {
    const nodeId = `${kind}:${id}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        type: kindToUiType(kind),
        label: prettyLabel(kind, id, clientLabel, labelByNodeKey),
        metadata: { kind, rawId: id, ...extras },
      });
    }
    return nodeId;
  };

  for (const row of filteredWalkRows) {
    const srcNodeId = upsertNode(row.src_kind, row.src_id, {
      source: row.source,
      observedAt: row.observed_at,
    });
    const dstNodeId = upsertNode(row.dst_kind, row.dst_id, {
      source: row.source,
      observedAt: row.observed_at,
    });

    const edgeKey = `${srcNodeId}->${dstNodeId}:${row.edge_type}`;
    if (!edgeMap.has(edgeKey)) {
      edgeMap.set(edgeKey, {
        source: srcNodeId,
        target: dstNodeId,
        type: row.edge_type,
        label: row.edge_type.replace(/_/g, ' '),
      });
    }
  }

  return { nodeMap, edgeMap };
}
