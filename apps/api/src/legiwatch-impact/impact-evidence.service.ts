import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { reviewHash } from '../clients/client-profile-fill-review-snapshot.js';
import { loadImpactBillEvidence } from './impact-bill-evidence.js';
import { loadImpactClientEvidence } from './impact-client-evidence.js';
import type { ImpactEvidenceSnapshot } from './impact-evidence.types.js';
export { IMPACT_CURRENT_FEDERAL_SQL, IMPACT_CURRENT_STATE_SQL } from './impact-bill-evidence.js';

/** Reads authorized retained records only. Caches are local to this transaction call. */
@Injectable()
export class ImpactEvidenceService {
  async load(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    billId: string,
  ): Promise<ImpactEvidenceSnapshot> {
    return (await this.loadMany(tx, ctx, [{ clientId, billId }]))[0]!;
  }

  async loadMany(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    pairs: ReadonlyArray<{ clientId: string; billId: string }>,
  ): Promise<ImpactEvidenceSnapshot[]> {
    const clients = new Map<
      string,
      Promise<{ facts: Awaited<ReturnType<typeof loadImpactClientEvidence>>; notes: Set<string> }>
    >();
    const bills = new Map<
      string,
      Promise<{ evidence: Awaited<ReturnType<typeof loadImpactBillEvidence>>; notes: Set<string> }>
    >();
    return Promise.all(
      pairs.map(async ({ clientId, billId }) => {
        if (!clients.has(clientId))
          clients.set(
            clientId,
            (async () => {
              const notes = new Set<string>();
              return { facts: await loadImpactClientEvidence(tx, ctx, clientId, notes), notes };
            })(),
          );
        if (!bills.has(billId))
          bills.set(
            billId,
            (async () => {
              const notes = new Set<string>();
              return { evidence: await loadImpactBillEvidence(tx, billId, notes), notes };
            })(),
          );
        const [client, bill] = await Promise.all([clients.get(clientId)!, bills.get(billId)!]);
        const { billStatus, versions, provisions, identity } = bill.evidence;
        const clientFacts = client.facts;
        const coverageNotes = [...new Set([...client.notes, ...bill.notes])].sort();
        const fingerprint = reviewHash({
          schema: 'legiwatch-impact-evidence-v1',
          clientId,
          billId,
          identity,
          versions,
          provisions,
          clientFacts,
          coverageNotes,
        });
        return {
          clientId,
          billId,
          fingerprint,
          billStatus,
          versions,
          provisions,
          clientFacts,
          coverageNotes,
        };
      }),
    );
  }
}
