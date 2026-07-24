import { Injectable, Logger } from '@nestjs/common';
import { estimateTokens, truncateToTokens, type MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';

export interface PackProvenance {
  sections: Array<{ name: string; count: number }>;
  omitted?: string[];
}

/** A8: context-health signal derived from what the pack could/couldn't load. */
export interface PackHealth {
  status: 'ok' | 'degraded';
  /** Required sections that could not be loaded (drives a degraded status). */
  missingRequired: string[];
  /** Optional sections omitted — includes wall-blocked KG/engagement, which is
   *  EXPECTED for a walled client and never marks the pack unhealthy. */
  omittedOptional: string[];
}

export interface CompiledPack {
  text: string;
  provenance: PackProvenance;
  health: PackHealth;
}

/** One resolved section: a rendered block (present) or bare name (omitted). */
interface Section {
  name: string;
  block?: string;
  count?: number;
}

/** Per-section token caps (CTX-3). No per-section budget in the compiler, so we
 *  budget each section independently with the token-budget primitives. */
const CAP = {
  profile: 1200,
  documents: 900,
  tracker: 500,
  intelligence: 700,
  kg: 900,
  engagement: 900,
} as const;
const SLIM_CAP = { profile: 1000, documents: 500, kg: 700 } as const;

/**
 * Client Context Pack (§6.13). Pre-compiled BEFORE the LLM loop by invoking the
 * delegated ToolExecutor (POST /api/clio/tools/:name under the caller bearer,
 * set by the controller's RequestCredentialsStore scope) — no read tools run in
 * the loop.
 *
 * CLIENT-ANCHORING (CTX-2 / CTX-4 — strictly client-scoped, no cross-client
 * content): every section is bounded to the STRATEGY's client.
 *   - client-OWN structured data (profile tabs, documents, tracker) is fetched
 *     with clientId and is tenant-scoped — the strategy IS for this client, so
 *     surfacing its own config is not a leak.
 *   - the knowledge graph is SEEDED on the client node (`client:<id>`) so the
 *     walk returns the client's neighborhood, not the whole-tenant graph.
 *   - prior engagement (search_memory) has no clientId filter server-side, so we
 *     POST-FILTER the rows to this client (or tenant-general, clientId null) and
 *     drop any other client's memory before rendering.
 *
 * WALL-CORRECTNESS (CTX-4 / pitfall #11 — phase-blocking): memory-derived
 * context (KG neighborhood + prior engagement) comes ONLY from the wall-riding
 * tools (search_memory / query_knowledge_graph), which fetchDeniedClientIds +
 * wallExclusionSql fail-closed for a walled client with no grant — so a walled
 * client yields EMPTY memory/engagement sections, never a leak. We deliberately
 * do NOT call query_debriefs here (it is tenant-scoped only, not wall-gated —
 * the known leak vector from the G5 grounding); the wall-riding search_memory is
 * the wall-correct source of debrief-derived prior engagement (CTX-2b).
 *
 * Every section is fail-open: a fetch error/empty result degrades to omission
 * (CTX-5), never blocking the draft/assistant call. Non-dependent sections run
 * concurrently (draft-latency, pitfall #12); only Intelligence waits on the
 * profile fetch (it needs the recovered client name). Provenance (CTX-6) records
 * section names + row counts (not content).
 */
@Injectable()
export class StrategyContextPackService {
  private readonly logger = new Logger(StrategyContextPackService.name);

  constructor(private readonly toolExecutor: ApiToolExecutorRepo) {}

  async compile(opts: {
    ctx: MeriContext;
    clientId: string;
    query: string;
    slim: boolean;
  }): Promise<CompiledPack> {
    const { ctx, clientId, query, slim } = opts;

    const run = async (
      name: string,
      cap: number,
      fetchFn: () => Promise<{ text: string; count: number } | null>,
    ): Promise<Section> => {
      try {
        const r = await fetchFn();
        const text = r ? truncateToTokens(r.text.trim(), cap) : '';
        if (r && text) return { name, block: `## ${name}\n${text}`, count: r.count };
        return { name };
      } catch (e) {
        this.logger.warn(`pack section "${name}" failed (omitted): ${(e as Error).message}`);
        return { name };
      }
    };

    // --- client profile first: its recovered name gates the (global) Intelligence
    // section, and it anchors the whole pack. get_client_context surfaces
    // overview + capabilities + people + facilities + submission history. ---
    let clientName: string | undefined;
    const profile = await run('Client profile', slim ? SLIM_CAP.profile : CAP.profile, async () => {
      const res = (await this.toolExecutor.execute(ctx, 'get_client_context', { clientId })) as
        | Record<string, unknown>
        | undefined;
      if (!res) return null;
      clientName = extractClientName(res);
      const profileObj = (res.profile ?? {}) as Record<string, unknown>;
      const count =
        arr(profileObj.capabilities) +
        arr(profileObj.people) +
        arr(profileObj.facilities) +
        arr(profileObj.submissionHistory);
      return { text: compact(res), count };
    });

    // --- everything else runs concurrently (no cross-section dependency except
    // Intelligence, gated on clientName which is already resolved above) ---
    const tasks: Array<Promise<Section>> = [];

    tasks.push(
      run('Relevant documents', slim ? SLIM_CAP.documents : CAP.documents, async () => {
        const res = (await this.toolExecutor.execute(ctx, 'search_client_knowledge', {
          query: query || 'client background and priorities',
          clientId,
          kind: 'client_doc_chunk',
          limit: slim ? 3 : 6,
        })) as { results?: unknown[] } | undefined;
        const results = Array.isArray(res?.results) ? res!.results : [];
        if (!results.length) return null;
        return { text: compact(res), count: results.length };
      }),
    );

    if (!slim) {
      tasks.push(
        run('Tracked bills', CAP.tracker, async () => {
          const res = (await this.toolExecutor.execute(ctx, 'search_tracked_bills', { clientId })) as
            | { bills?: unknown[]; results?: unknown[]; data?: unknown[] }
            | undefined;
          // search_tracked_bills returns rows under `bills` (not results/data).
          const rows = (res?.bills ?? res?.results ?? res?.data) ?? [];
          if (!Array.isArray(rows) || !rows.length) return null;
          return { text: compact(res), count: rows.length };
        }),
      );

      // Federal intelligence is GLOBAL — only useful client-filtered, so skip
      // unless we recovered the client name (avoids dumping unrelated intel).
      tasks.push(
        clientName
          ? run('Intelligence', CAP.intelligence, async () => {
              const res = (await this.toolExecutor.execute(ctx, 'query_intelligence', {
                clientName,
              })) as { data?: unknown; results?: unknown[] } | undefined;
              // query_intelligence returns `data` as a newline-joined STRING
              // (with a "No intelligence data…" sentinel when empty).
              const data = typeof res?.data === 'string' ? res.data.trim() : '';
              if (!data || /^no intelligence data/i.test(data)) return null;
              return { text: data, count: 1 };
            })
          : Promise.resolve<Section>({ name: 'Intelligence' }),
      );
    }

    // --- memory-derived context (WALL-RIDING tools only), client-anchored ---
    tasks.push(
      run('Knowledge graph', slim ? SLIM_CAP.kg : CAP.kg, async () => {
        const res = (await this.toolExecutor.execute(ctx, 'query_knowledge_graph', {
          // Seed on the client node so the walk returns the client's neighborhood
          // (CTX-2), not the whole-tenant graph (which would bleed other clients).
          seed: `client:${clientId}`,
          depth: 2,
        })) as { nodes?: unknown[]; summary?: unknown } | undefined;
        const nodes = Array.isArray(res?.nodes) ? res!.nodes : [];
        if (!nodes.length && !str(res?.summary)) return null;
        return { text: compact(res), count: nodes.length };
      }),
    );

    if (!slim) {
      tasks.push(
        run('Prior engagement', CAP.engagement, async () => {
          const res = (await this.toolExecutor.execute(ctx, 'search_memory', {
            query: `prior meetings, debriefs, commitments, and stakeholder positions relevant to: ${query || 'this client'}`,
            k: 8,
          })) as { results?: unknown[]; items?: unknown[] } | undefined;
          const raw = (Array.isArray(res?.results) ? res!.results : res?.items) ?? [];
          // CTX-4 client-anchor: search_memory has no client filter, so drop any
          // row belonging to a DIFFERENT client; keep this client's + tenant-
          // general (clientId null) memory only.
          const rows = (Array.isArray(raw) ? raw : []).filter((r) => {
            const cid = (r as { clientId?: unknown }).clientId;
            return cid == null || cid === clientId;
          });
          if (!rows.length) return null;
          return { text: compact({ results: rows }), count: rows.length };
        }),
      );
    }

    const rest = await Promise.all(tasks);

    // --- assemble in a fixed order (profile first), independent of resolution order ---
    const blocks: string[] = [];
    const sections: Array<{ name: string; count: number }> = [];
    const omitted: string[] = [];
    for (const sec of [profile, ...rest]) {
      if (sec.block) {
        blocks.push(sec.block);
        sections.push({ name: sec.name, count: sec.count ?? 0 });
      } else {
        omitted.push(sec.name);
      }
    }
    // targets tab: no dedicated delegated read tool exists (ClientTarget /
    // OfficeRecommendation) — documented gap, recorded in provenance.
    omitted.push('Targets (no read tool)');

    const text = blocks.length ? blocks.join('\n\n') : '(no client context available)';
    // A8: the client profile is the one REQUIRED section; its absence degrades the
    // pack. Everything else is optional — and a wall-blocked client's empty
    // KG/engagement sections land in omittedOptional, never missingRequired, so a
    // walled client is never flagged unhealthy.
    const REQUIRED = ['Client profile'];
    const missingRequired = REQUIRED.filter((r) => omitted.includes(r));
    const omittedOptional = omitted.filter((o) => !REQUIRED.includes(o));
    const health: PackHealth = {
      status: missingRequired.length ? 'degraded' : 'ok',
      missingRequired,
      omittedOptional,
    };
    this.logger.log(
      `pack compiled (${slim ? 'slim' : 'full'}): ${sections.length} sections, ~${estimateTokens(text)} tokens, health=${health.status}`,
    );
    return { text, provenance: { sections, omitted }, health };
  }
}

function arr(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Compact JSON of a tool result minus wrapper noise, for prompt inclusion. */
function compact(res: unknown): string {
  if (!res || typeof res !== 'object') return '';
  const { tool, generatedAt, ...rest } = res as Record<string, unknown>;
  void tool;
  void generatedAt;
  try {
    return JSON.stringify(rest);
  } catch {
    return '';
  }
}

/** Best-effort client display name from get_client_context, for the intel filter. */
function extractClientName(res: Record<string, unknown>): string | undefined {
  const ctx = res.context as Record<string, unknown> | undefined;
  const candidates = [
    (ctx?.client as Record<string, unknown> | undefined)?.name,
    ctx?.name,
    ctx?.clientName,
    (res.client as Record<string, unknown> | undefined)?.name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}
