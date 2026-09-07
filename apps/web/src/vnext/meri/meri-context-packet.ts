import type { MeriContextPacket, MeriContextPacketItem } from './meri-vnext-api.js';
import { meriCoverageReason } from '../../components/chat/meri-retrieval-metadata.js';
import type {
  MeriContextExclusion,
  MeriContextExclusionTone,
  MeriContextItem,
  MeriContextPacket as MeriEvidenceContextPacket,
} from './MeriEvidenceTray.js';

function scope(value: MeriContextPacketItem['scope']): MeriContextItem['scope'] {
  if (value === 'client') return 'CLIENT';
  if (value === 'personal') return 'PERSONAL';
  return 'FIRM';
}

function exclusionTone(reason: string): MeriContextExclusionTone {
  if (/unavailable|expired|error|failed|denied/i.test(reason)) return 'w';
  if (/wrong-client|unauthorized|sensitivity/i.test(reason)) return 'b';
  return 'n';
}

export function contextItemLabel(label: string, type?: string): string {
  if (/learning[ _-]signal/i.test(label) && /[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(label))
    return 'Learning signal';
  if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(label))
    return type ? type.replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) : 'Context item';
  return /^(source_unavailable|source_error|source_not_searched|source_degraded):/.test(label)
    ? meriCoverageReason(label) : label;
}

export function evidenceContextPacket(packet: MeriContextPacket): MeriEvidenceContextPacket {
  return {
    degraded: packet.degraded ? meriCoverageReason(packet.degradedReason ?? 'Initial context provenance is unavailable for this answer.') : null,
    included: packet.items.map((item) => ({
      name: contextItemLabel(item.label, item.type),
      type: item.type.replace(/_/g, ' ').toUpperCase(),
      scope: scope(item.scope),
      auto: item.selection !== 'explicit',
      rationale: item.rationale ?? 'Included by the server-side context compiler.',
      meta: [
        `AUTHORITY · ${item.authority.replace(/_/g, ' ').toUpperCase()}`,
        ...(item.status ? [`STATUS · ${item.status.replace(/_/g, ' ').toUpperCase()}`] : []),
        ...(item.asOf ? [`AS OF · ${new Date(item.asOf).toLocaleDateString()}`] : []),
        ...(item.lastConfirmedAt ? [`CONFIRMED · ${new Date(item.lastConfirmedAt).toLocaleDateString()}`] : []),
      ],
    })),
    excluded: packet.exclusions.map((item) => ({
      name: contextItemLabel(item.label, item.type),
      reason: meriCoverageReason(item.reason),
      tone: exclusionTone(item.reason),
      restricted: /wrong-client|unauthorized|sensitivity/i.test(item.reason),
    })),
    packet: packet.packetId ? `CONTEXT PACKET · ${packet.packetId.slice(0, 8)}` : 'CONTEXT PACKET UNAVAILABLE',
  };
}

export function activeContextLabels(packet: MeriContextPacket | null): Array<{ id: string; title: string; kind: string }> {
  if (!packet) return [];
  return packet.items.map((item) => ({
    id: item.id,
    title: contextItemLabel(item.label, item.type),
    kind: item.type.replace(/_/g, ' ').toUpperCase(),
  }));
}

export function contextPacketSummary(packet: MeriContextPacket | null): string {
  if (!packet) return 'Context provenance has not been loaded.';
  if (packet.degraded) return meriCoverageReason(packet.degradedReason ?? 'Initial context provenance is incomplete.');
  if (!packet.items.length) return 'No context items were compiled for this thread.';
  return `${packet.items.length} context item${packet.items.length === 1 ? '' : 's'} compiled for this thread.`;
}
