import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientContextGraphWalkRow } from './client-context-v1-graph.js';

export class ClientContextV1GraphLabels {
  constructor(private readonly prisma: PrismaService) {}

  collectNodeIds(walkRows: ClientContextGraphWalkRow[]) {
    // Step 1, drop unconfirmed auto-match noise.
    //
    // The entity resolver writes a row to client_intel_mapping for EVERY
    // candidate LDA/FEC/contracting match it finds, then waits for a human
    // to confirm one. Until then those mappings have `confirmed = false`
    // and our view emits one client→lda_client edge per candidate, which
    // is what produced the 68-node "all AGENCY" mess in the screenshot.
    //
    // The graph should reflect the *resolved* state, not the candidate
    // pool. We drop edges where source='auto_matched' (the marker we set
    // in kg_tenant_edges for unconfirmed mappings) so only manually
    // confirmed bridges + canonical edges remain.
    const filteredWalkRows = walkRows.filter((r) => r.source !== 'auto_matched');

    // Step 2, batch-resolve human labels for ID-keyed kinds.
    //
    // Many node kinds use opaque numeric IDs (LDA client = int, LDA
    // registrant = int, LDA lobbyist = int, FEC committee = string code)
    // or UUIDs (federal_contractor, capability). Without a name lookup
    // the graph rendered "189497" / "67101" / raw UUIDs as labels.
    // Collect the ids per kind across the filtered walk, then do one
    // SELECT per kind to build a kind:id → name map.
    const idsByKind = new Map<string, Set<string>>();

    const collect = (kind: string, id: string) => {
      const set = idsByKind.get(kind) ?? new Set<string>();
      set.add(id);
      idsByKind.set(kind, set);
    };

    for (const row of filteredWalkRows) {
      collect(row.src_kind, row.src_id);
      collect(row.dst_kind, row.dst_id);
    }

    return { filteredWalkRows, idsByKind };
  }

  startNumericLookups(
    idsByKind: Map<string, Set<string>>,
    labelByNodeKey: Map<string, string>,
    lookups: Array<Promise<void>>,
  ) {
    const ldaClientIds = Array.from(idsByKind.get('lda_client') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));

    if (ldaClientIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
            SELECT id, name FROM lda_client WHERE id = ANY(${ldaClientIds}::int[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`lda_client:${r.id}`, r.name);
        }),
      );
    }

    const ldaRegistrantIds = Array.from(idsByKind.get('lda_registrant') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));

    if (ldaRegistrantIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
            SELECT id, name FROM lda_registrant WHERE id = ANY(${ldaRegistrantIds}::int[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`lda_registrant:${r.id}`, r.name);
        }),
      );
    }

    const ldaLobbyistIds = Array.from(idsByKind.get('lda_lobbyist') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));

    if (ldaLobbyistIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; first_name: string; last_name: string }>>`
            SELECT id, first_name, last_name FROM lda_lobbyist WHERE id = ANY(${ldaLobbyistIds}::int[])
          `.then((rows) => {
          for (const r of rows) {
            const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();
            labelByNodeKey.set(`lda_lobbyist:${r.id}`, name || `Lobbyist ${r.id}`);
          }
        }),
      );
    }
  }

  startStringLookups(
    idsByKind: Map<string, Set<string>>,
    labelByNodeKey: Map<string, string>,
    lookups: Array<Promise<void>>,
    tenantId: string,
  ) {
    const contractorIds = Array.from(idsByKind.get('federal_contractor') ?? []);

    if (contractorIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
            SELECT id, name FROM federal_contractor WHERE id::text = ANY(${contractorIds}::text[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`federal_contractor:${r.id}`, r.name);
        }),
      );
    }

    const fecCommitteeIds = Array.from(idsByKind.get('fec_committee') ?? []);

    if (fecCommitteeIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ committee_id: string; committee_name: string | null }>>`
            SELECT DISTINCT committee_id, committee_name
            FROM fec_contribution
            WHERE committee_id = ANY(${fecCommitteeIds}::text[])
              AND committee_name IS NOT NULL
          `.then((rows) => {
          for (const r of rows) {
            if (r.committee_name)
              labelByNodeKey.set(`fec_committee:${r.committee_id}`, r.committee_name);
          }
        }),
      );
    }

    const capabilityIds = Array.from(idsByKind.get('capability') ?? []);

    if (capabilityIds.length) {
      lookups.push(
        this.prisma
          .withTenant(tenantId, (tx) =>
            tx.clientCapability.findMany({
              where: { id: { in: capabilityIds }, tenantId },
              select: { id: true, name: true },
            }),
          )
          .then((rows) => {
            for (const r of rows) labelByNodeKey.set(`capability:${r.id}`, r.name);
          }),
      );
    }
  }
}
