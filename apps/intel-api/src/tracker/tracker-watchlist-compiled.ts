import { compileWatchlist, type CompiledWatchlist } from '../watchlist/watchlist-compiler.js';
import { termSurfaceMap, weightForTerm, type TermRoute } from '../watchlist/term-routing.js';
import type { TrackerWatchlistService } from './tracker-watchlist.service.js';
export class TrackerWatchlistCompiled {
  async getCompiled(
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
  ): Promise<
    CompiledWatchlist & {
      jurisdictions: string[];
      termSurfaces: Record<string, TermRoute['surfaces']>;
    }
  > {
    const wl = await host['getWatchlist'](tenantId, clientId);
    const compiled = compileWatchlist({
      issueAreas: wl.issueAreas,
      topics: wl.topics.map((t) => ({
        id: t.id ?? null,
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
      })),
      terms: wl.topics.flatMap((t) =>
        t.terms.map((x) => ({
          termType: x.termType,
          value: x.value,
          // §4.9: was hardcoded 1 for every term, which made the Deepgram cap a
          // lexical coin-flip once a client had more than 100 terms.
          weight: weightForTerm(x.termType, t.priority),
          topicLabel: t.label,
          topicPriority: t.priority,
          termId: x.id ?? null,
        })),
      ),
    });
    // §4.13: the compiler is pure, so IT cannot log — surface the cap here, at the
    // boundary. A silent truncation would read as full coverage.
    if (compiled.truncatedTopics.length) {
      for (const t of compiled.truncatedTopics) {
        host['logger'].warn(
          `watchlist term cap hit: client=${clientId} topic="${t.label}" kept=${t.kept} dropped=${t.dropped} — the dropped (lowest-weight) terms do not affect bill matching`,
        );
      }
    }
    // State Legislation Platform (DD5) — jurisdictions ride alongside the pure
    // compiler output rather than threading through compileWatchlist itself
    // (which stays a pure function of issueAreas/topics/terms only).
    // P0-04: termSurfaces lets the Configure UI preview which surfaces each
    // term type affects (b-7) — static, not derived from this client's data.
    return { ...compiled, jurisdictions: wl.jurisdictions, termSurfaces: termSurfaceMap() };
  }
}
