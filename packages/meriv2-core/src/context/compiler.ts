/**
 * Context Compiler v1 — assembly, rendering, exclusion tracing (G1).
 *
 * Pure logic over a ContextStoreAdapter: classify rows into layers, filter to
 * the requested layers, exclude non-active / empty / over-budget rows WITH A
 * RECORDED REASON, render human-owned section bodies with the ONE shared
 * renderer (previously copy-pasted four times), and fire-and-forget the packet
 * trace. Zod-free, Node-builtin-only (crypto.randomUUID) — see contract.ts for
 * why this subpath must stay dependency-free.
 */
import { randomUUID } from 'node:crypto';
import { estimateTokens } from './token-budget';
import {
  LAYER_BY_TYPE,
  type CompiledContextPacket,
  type ContextExclusion,
  type ContextPacketItem,
  type ContextRequest,
  type ContextStoreAdapter,
  type RenderedSteeringItem,
  type SteeringLayer,
  type SteeringRow,
} from './contract';

/** Stable, human-readable inclusion rationales per layer (packet trace). */
const RATIONALE: Readonly<Record<SteeringLayer, string>> = {
  'firm-identity': 'Firm Soul/Compass: firm identity always steers firm-scoped drafting',
  'firm-playbook': 'Firm playbook: house drafting doctrine for deliverables',
  'user-voice': "Author's writing voice/profile (private, owner-scoped)",
  'client-steering': "Client soul/compass: the client's approved framing",
  'client-people': 'Client people roster: named principals for this client',
};

/**
 * THE shared human-sections renderer. Only sections a human owns are ever
 * rendered into prompts (`owner === 'human'`); Meri-owned sections are
 * derived content and must not steer generation. Formerly quadruplicated in
 * meri.service / engagement.service / meri-context.resolver /
 * generation.service — byte-identical output to those copies.
 */
export function renderHumanSections(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  return sections
    .filter((s) => s && typeof s === 'object' && (s as { owner?: string }).owner === 'human')
    .map((s) => {
      const sec = s as { heading?: string; body?: string };
      return sec.body?.trim() ? `${sec.heading}: ${sec.body.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 'all' render mode: every non-empty section body regardless of owner, no
 * heading prefix — alert-memo's historical full-file steering shape.
 */
export function renderAllSections(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  return sections
    .map((s) => {
      const sec = s as { body?: string } | null;
      return typeof sec?.body === 'string' ? sec.body.trim() : '';
    })
    .filter(Boolean)
    .join('\n');
}

export class ContextCompiler {
  constructor(private readonly store: ContextStoreAdapter) {}

  async compile(req: ContextRequest): Promise<CompiledContextPacket> {
    const rows = await this.store.loadSteeringRows(req);

    const wanted = new Set<SteeringLayer>(req.layers);
    const items: ContextPacketItem[] = [];
    const exclusions: ContextExclusion[] = [];
    const rendered: RenderedSteeringItem[] = [];

    // Stable ordering: requested-layer order first, then adapter row order —
    // so prompt-block composition is deterministic across compiles.
    const byLayer = new Map<SteeringLayer, SteeringRow[]>();
    for (const row of rows) {
      const layer = LAYER_BY_TYPE[row.type];
      if (!layer || !wanted.has(layer)) continue; // not requested: not traced
      const bucket = byLayer.get(layer) ?? [];
      bucket.push(row);
      byLayer.set(layer, bucket);
    }

    // Phase 5: unit-aware budgeting. Default ('chars' / undefined) is byte-
    // identical to before (cost = body.length, budget = charBudget). 'tokens'
    // routes both the budget and the per-row cost through the shared estimator.
    const useTokens = req.budgetUnit === 'tokens';
    const cost = (body: string): number => (useTokens ? estimateTokens(body) : body.length);
    let budgetLeft =
      (useTokens ? req.tokenBudget : req.charBudget) ?? Number.POSITIVE_INFINITY;
    for (const layer of req.layers) {
      for (const row of byLayer.get(layer) ?? []) {
        const base = { layer, id: row.id, type: row.type, slug: row.slug };
        const withTitle = { ...base, title: row.title ?? null };
        // Governance first: superseded/revoked rows are visible to the
        // compiler (the adapter must not status-filter) precisely so the
        // withholding is RECORDED rather than silent.
        if (row.status === 'revoked' || row.status === 'superseded') {
          exclusions.push({ ...base, reason: row.status });
          continue;
        }
        // G2 ephemeral: the RLS expiry predicate normally hides expired rows
        // before they reach the adapter — this in-code check is defense in
        // depth (and the only guard for rows read under rls_bypass), and it
        // makes the withholding visible in the trace when it does fire.
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
          exclusions.push({ ...base, reason: 'expired' });
          continue;
        }
        const body =
          req.render === 'all'
            ? renderAllSections(row.sections)
            : renderHumanSections(row.sections);
        if (!body) {
          exclusions.push({ ...base, reason: 'empty' });
          continue;
        }
        const bodyCost = cost(body);
        if (bodyCost > budgetLeft) {
          exclusions.push({ ...base, reason: 'over-budget' });
          continue;
        }
        budgetLeft -= bodyCost;
        // `chars` remains the field name (contract-stable); it carries the cost
        // in the active unit (chars by default, estimated tokens when on).
        items.push({ ...base, chars: bodyCost, rationale: RATIONALE[layer] });
        rendered.push({ ...withTitle, body });
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
      compiledAt: new Date().toISOString(),
    };

    // Trace persistence is fail-open and non-blocking by contract: losing a
    // trace row must never cost a user their draft.
    if (this.store.persistPacket) {
      void this.store.persistPacket(packet).catch(() => undefined);
    }

    return packet;
  }
}

/** First rendered body for a type, or undefined — the common composition op. */
export function renderedBody(packet: CompiledContextPacket, type: string): string | undefined {
  return packet.rendered.find((r) => r.type === type)?.body;
}

/** All rendered bodies for a layer, in packet order. */
export function renderedLayer(
  packet: CompiledContextPacket,
  layer: SteeringLayer,
): RenderedSteeringItem[] {
  return packet.rendered.filter((r) => r.layer === layer);
}
