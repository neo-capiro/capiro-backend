import { Injectable, Logger } from '@nestjs/common';
import { estimateTokens, truncateToTokens, type MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';

export interface PackProvenance {
  sections: Array<{ name: string; count: number }>;
  omitted?: string[];
}

export interface CompiledPack {
  text: string;
  provenance: PackProvenance;
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
 * WALL-CORRECTNESS (CTX-4 / pitfall #11 — phase-blocking): client-OWN structured
 * data (profile tabs, documents, tracker, intelligence) is tenant-scoped — the
 * strategy IS for this client, so surfacing its own config/intel is not a leak.
 * Memory-derived context (prior engagement + KG neighborhood) comes ONLY from
 * the wall-riding tools (search_memory / query_knowledge_graph), which
 * fetchDeniedClientIds + wallExclusionSql fail-closed for a walled client with
 * no grant — so a walled client yields EMPTY memory/engagement sections, never
 * a leak. We deliberately do NOT call query_debriefs here (it is tenant-scoped
 * only, not wall-gated — the known leak vector from the G5 grounding); the
 * wall-riding search_memory is the wall-correct source of debrief-derived prior
 * engagement (CTX-2b, wall-safe form).
 *
 * Every section is fail-open: a fetch error/empty result degrades to omission
 * (CTX-5), never blocking the draft/assistant call. Provenance (CTX-6) records
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
    const blocks: string[] = [];
    const sections: Array<{ name: string; count: number }> = [];
    const omitted: string[] = [];

    const run = async (
      name: string,
      cap: number,
      fetchFn: () => Promise<{ text: string; count: number } | null>,
    ): Promise<unknown> => {
      try {
        const r = await fetchFn();
        const text = r ? truncateToTokens(r.text.trim(), cap) : '';
        if (r && text) {
          blocks.push(`## ${name}\n${text}`);
          sections.push({ name, count: r.count });
        } else {
          omitted.push(name);
        }
      } catch (e) {
        this.logger.warn(`pack section "${name}" failed (omitted): ${(e as Error).message}`);
        omitted.push(name);
      }
      return undefined;
    };

    // --- client-OWN structured data (tenant-scoped) ---
    // get_client_context surfaces overview + capabilities + people + facilities +
    // submission history. Cache the result so intelligence can reuse the name.
    let clientName: string | undefined;
    await run('Client profile', slim ? SLIM_CAP.profile : CAP.profile, async () => {
      const res = (await this.toolExecutor.execute(ctx, 'get_client_context', { clientId })) as
        | Record<string, unknown>
        | undefined;
      if (!res) return null;
      clientName = extractClientName(res);
      const profile = (res.profile ?? {}) as Record<string, unknown>;
      const count =
        arr(profile.capabilities) + arr(profile.people) + arr(profile.facilities) + arr(profile.submissionHistory);
      return { text: compact(res), count };
    });

    await run('Relevant documents', slim ? SLIM_CAP.documents : CAP.documents, async () => {
      const res = (await this.toolExecutor.execute(ctx, 'search_client_knowledge', {
        query: query || 'client background and priorities',
        clientId,
        kind: 'client_doc_chunk',
        limit: slim ? 3 : 6,
      })) as { results?: unknown[] } | undefined;
      const results = Array.isArray(res?.results) ? res!.results : [];
      if (!results.length) return null;
      return { text: compact(res), count: results.length };
    });

    if (!slim) {
      await run('Tracked bills', CAP.tracker, async () => {
        const res = (await this.toolExecutor.execute(ctx, 'search_tracked_bills', { clientId })) as
          | { results?: unknown[]; data?: unknown[] }
          | undefined;
        const rows = (Array.isArray(res?.results) ? res!.results : res?.data) ?? [];
        if (!Array.isArray(rows) || !rows.length) return null;
        return { text: compact(res), count: rows.length };
      });

      // Federal intelligence is GLOBAL — only useful client-filtered, so skip
      // unless we recovered the client name (avoids dumping unrelated intel).
      if (clientName) {
        await run('Intelligence', CAP.intelligence, async () => {
          const res = (await this.toolExecutor.execute(ctx, 'query_intelligence', {
            clientName,
          })) as { results?: unknown[]; data?: unknown[] } | undefined;
          const rows = (Array.isArray(res?.results) ? res!.results : res?.data) ?? [];
          if (!Array.isArray(rows) || !rows.length) return null;
          return { text: compact(res), count: rows.length };
        });
      } else {
        omitted.push('Intelligence');
      }
    }

    // --- memory-derived context (WALL-RIDING tools only) ---
    await run('Knowledge graph', slim ? SLIM_CAP.kg : CAP.kg, async () => {
      const res = (await this.toolExecutor.execute(ctx, 'query_knowledge_graph', { depth: 2 })) as
        | { nodes?: unknown[]; summary?: unknown }
        | undefined;
      const nodes = Array.isArray(res?.nodes) ? res!.nodes : [];
      if (!nodes.length && !str(res?.summary)) return null;
      return { text: compact(res), count: nodes.length };
    });

    if (!slim) {
      await run('Prior engagement', CAP.engagement, async () => {
        const res = (await this.toolExecutor.execute(ctx, 'search_memory', {
          query: `prior meetings, debriefs, commitments, and stakeholder positions relevant to: ${query || 'this client'}`,
          k: 8,
        })) as { results?: unknown[]; items?: unknown[] } | undefined;
        const rows = (Array.isArray(res?.results) ? res!.results : res?.items) ?? [];
        if (!Array.isArray(rows) || !rows.length) return null;
        return { text: compact(res), count: rows.length };
      });
    }

    // targets tab: no dedicated delegated read tool exists (ClientTarget /
    // OfficeRecommendation) — documented gap, recorded in provenance.
    omitted.push('Targets (no read tool)');

    const text = blocks.length ? blocks.join('\n\n') : '(no client context available)';
    this.logger.log(
      `pack compiled (${slim ? 'slim' : 'full'}): ${sections.length} sections, ~${estimateTokens(text)} tokens`,
    );
    return { text, provenance: { sections, omitted } };
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
