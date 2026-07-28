/** Context Compiler v1 — deterministic assembly and auditable exclusions. */
import { createHash, randomUUID } from 'node:crypto';
import { estimateTokens } from './token-budget';
import {
  LAYER_BY_TYPE,
  typeRank,
  type CompiledContextPacket,
  type ContextExclusion,
  type ContextPacketItem,
  type ContextRequest,
  type ContextStoreAdapter,
  type RenderedSteeringItem,
  type SteeringLayer,
  type SteeringRow,
} from './contract';

const RATIONALE: Readonly<Record<SteeringLayer, string>> = {
  'firm-identity': 'Firm Soul/Compass: firm identity always steers firm-scoped drafting',
  'firm-playbook': 'Firm playbook: house drafting doctrine for deliverables',
  'user-voice': "Author's writing voice/profile (private, owner-scoped)",
  'client-steering': "Client soul/compass: the client's approved framing",
  'client-people': 'Client people roster: named principals for this client',
};

export function renderHumanSections(sections: unknown): string {
  return renderSectionUnits(sections, 'human')
    .map((unit) => unit.body)
    .join('\n');
}

export function renderAllSections(sections: unknown): string {
  return renderSectionUnits(sections, 'all')
    .map((unit) => unit.body)
    .join('\n');
}

interface SectionUnit {
  label: string;
  body: string;
}

function renderSectionUnits(sections: unknown, mode: 'human' | 'all'): SectionUnit[] {
  if (!Array.isArray(sections)) return [];
  const out: SectionUnit[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const raw = sections[index];
    if (!raw || typeof raw !== 'object') continue;
    const section = raw as { owner?: string; heading?: string; body?: string };
    if (mode === 'human' && section.owner !== 'human') continue;
    const body = typeof section.body === 'string' ? section.body.trim() : '';
    if (!body) continue;
    const heading = section.heading?.trim() || `section-${index + 1}`;
    out.push({ label: heading, body: mode === 'human' ? `${heading}: ${body}` : body });
  }
  return out;
}

export class ContextCompiler {
  constructor(private readonly store: ContextStoreAdapter) {}

  async compile(req: ContextRequest): Promise<CompiledContextPacket> {
    const rows = await this.store.loadSteeringRows(req);
    const wanted = new Set<SteeringLayer>(req.layers);
    const items: ContextPacketItem[] = [];
    const exclusions: ContextExclusion[] = [];
    const rendered: RenderedSteeringItem[] = [];

    const byLayer = new Map<SteeringLayer, SteeringRow[]>();
    for (const row of rows) {
      const layer = LAYER_BY_TYPE[row.type];
      if (!layer || !wanted.has(layer)) continue;
      const bucket = byLayer.get(layer) ?? [];
      bucket.push(row);
      byLayer.set(layer, bucket);
    }
    // Adapter SQL ordering is defense-in-depth only. The shared compiler sorts
    // independently so shuffled adapters produce identical packets.
    for (const bucket of byLayer.values()) bucket.sort(compareSteeringRows);

    const useTokens = req.budgetUnit === 'tokens';
    const cost = (body: string): number => (useTokens ? estimateTokens(body) : body.length);
    let budgetLeft = (useTokens ? req.tokenBudget : req.charBudget) ?? Number.POSITIVE_INFINITY;

    for (const layer of req.layers) {
      for (const row of byLayer.get(layer) ?? []) {
        const base = { layer, id: row.id, type: row.type, slug: row.slug };
        if (row.status === 'revoked' || row.status === 'superseded') {
          exclusions.push({ ...base, reason: row.status });
          continue;
        }
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
          exclusions.push({ ...base, reason: 'expired' });
          continue;
        }

        const units = renderSectionUnits(row.sections, req.render === 'all' ? 'all' : 'human');
        if (!units.length) {
          exclusions.push({ ...base, reason: 'empty' });
          continue;
        }

        const selected: SectionUnit[] = [];
        const omitted: string[] = [];
        let selectedCost = 0;
        for (const unit of units) {
          const separator = selected.length ? '\n' : '';
          const incremental = cost(`${separator}${unit.body}`);
          if (incremental <= budgetLeft - selectedCost) {
            selected.push(unit);
            selectedCost += incremental;
          } else {
            omitted.push(unit.label);
          }
        }
        if (!selected.length) {
          exclusions.push({ ...base, reason: 'over-budget' });
          continue;
        }

        const body = selected.map((unit) => unit.body).join('\n');
        const contentHash = sha256(body);
        budgetLeft -= selectedCost;
        items.push({
          ...base,
          chars: selectedCost,
          rationale: RATIONALE[layer],
          contentHash,
          ...(omitted.length ? { omittedSections: omitted } : {}),
        });
        rendered.push({ ...base, title: row.title ?? null, body, contentHash });
      }
    }

    const packet: CompiledContextPacket = {
      packetId: randomUUID(),
      version: 1,
      surface: req.surface,
      tenantId: req.tenantId,
      userId: req.userId,
      clientId: req.clientId ?? null,
      ref: req.ref ?? {},
      items,
      exclusions,
      rendered,
      traceHash: sha256(
        stableStringify({
          version: 1,
          surface: req.surface,
          tenantId: req.tenantId,
          userId: req.userId,
          clientId: req.clientId ?? null,
          ref: req.ref ?? {},
          items,
          exclusions,
          rendered,
        }),
      ),
      persisted: false,
      compiledAt: new Date().toISOString(),
    };

    if (this.store.persistPacket) {
      try {
        await this.store.persistPacket(packet);
        // Set only AFTER the write resolves: `persisted` is what lets a surface
        // claim `packetId` as a durable row, so it must never be true on a
        // packet whose insert has not actually completed.
        packet.persisted = true;
      } catch (error) {
        packet.persisted = false;
        if (req.persistence === 'required') throw error;
      }
    }
    return packet;
  }
}

function compareSteeringRows(a: SteeringRow, b: SteeringRow): number {
  return (
    // Canonical type rank FIRST within a layer: Firm Soul before Firm Compass,
    // Client Soul before Client Compass. Alphabetical `type` ordering would invert
    // both while still looking deterministic.
    typeRank(a.type) - typeRank(b.type) ||
    statusRank(a.status) - statusRank(b.status) ||
    compareNullableText(a.authority, b.authority) ||
    compareDateDesc(a.confirmedAt, b.confirmedAt) ||
    compareDateDesc(a.updatedAt, b.updatedAt) ||
    a.type.localeCompare(b.type) ||
    a.slug.localeCompare(b.slug) ||
    a.id.localeCompare(b.id)
  );
}

function statusRank(status: string): number {
  if (status === 'active') return 0;
  if (status === 'superseded') return 1;
  if (status === 'revoked') return 2;
  return 3;
}

function compareNullableText(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

function compareDateDesc(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
): number {
  const left = a ? new Date(a).getTime() : 0;
  const right = b ? new Date(b).getTime() : 0;
  return right - left;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function renderedBody(packet: CompiledContextPacket, type: string): string | undefined {
  return packet.rendered.find((item) => item.type === type)?.body;
}

export function renderedLayer(
  packet: CompiledContextPacket,
  layer: SteeringLayer,
): RenderedSteeringItem[] {
  return packet.rendered.filter((item) => item.layer === layer);
}
