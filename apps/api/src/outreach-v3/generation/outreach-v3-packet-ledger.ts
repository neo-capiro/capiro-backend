import type { LedgerEntry } from '@capiro/meriv2-core';
import type {
  EvidenceItem,
  EvidencePacketV2,
} from '../../engagement/generation/evidence-packet.types.js';

/**
 * Derive the auditor ledger from the SAME effective packet the writer and
 * deterministic verifier saw. This avoids a parallel, caller-maintained truth
 * copy drifting from the persisted Evidence Packet.
 */
export function buildOutreachV3PacketLedger(packet: EvidencePacketV2): LedgerEntry[] {
  return [...packet.evidence].sort(compareEvidenceIdentity).map((item) => ({
    tool: ledgerToolFor(item),
    serialized: item.evidenceText,
    result: item.structuredTruth ?? {
      sourceType: item.ref.sourceType,
      sourceId: item.ref.sourceId,
      title: item.ref.title,
      trust: item.ref.trust,
      clientId: item.ref.clientId ?? null,
      authoritativeAsOf: item.ref.authoritativeAsOf ?? null,
      recipientKeys: item.ref.recipientKeys ?? [],
      packetId: packet.packetId,
      packetHash: packet.packetHash,
    },
  }));
}

function ledgerToolFor(item: EvidenceItem): string {
  if (item.ref.sourceType === 'bill') return 'get_bill_status';
  if (item.ref.sourceType === 'programElement') return 'get_pe_budget_timeline';
  return `outreach_evidence:${item.ref.sourceType}`;
}

function compareEvidenceIdentity(a: EvidenceItem, b: EvidenceItem): number {
  const left = `${a.scope}|${a.ref.sourceType}|${a.ref.sourceId}`;
  const right = `${b.scope}|${b.ref.sourceType}|${b.ref.sourceId}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
