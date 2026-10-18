import type { TrackerBoardService } from './tracker-board.service.js';
import type {
  Watchlist,
  WatchlistTopic,
  WatchlistTerm,
} from '../../generated/prisma-client/index.js';
import { HEARING_TERMS_TOPIC_LABEL, isReservedTopicLabel } from './tracker-watchlist.service.js';
import {
  compileWatchlist,
  type CompilerTopic,
  type CompilerTerm,
} from '../watchlist/watchlist-compiler.js';
import type { CompiledTopicForFit } from './bill-fit.util.js';

type BatchWatchlist = Pick<Watchlist, 'clientId' | 'issueAreas'>;
type BatchTopic = Pick<
  WatchlistTopic,
  'id' | 'watchlistId' | 'label' | 'issueArea' | 'position' | 'priority'
>;
type BatchTerm = Pick<
  WatchlistTerm,
  'watchlistId' | 'topicId' | 'termType' | 'value' | 'weight' | 'id'
>;

export class TrackerBoardTopics {
  async compiledTopics(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
  ): Promise<{
    topics: CompiledTopicForFit[];
    issueAreas: string[];
    terms: string[];
    jurisdictions: string[];
  }> {
    const compiled = await host['watchlists'].getCompiled(tenantId, clientId);
    const topics: CompiledTopicForFit[] = compiled.billMatchSet.map((t) => ({
      id: t.id,
      label: t.label,
      issueArea: t.issueArea,
      priority: t.priority,
      // P0-06: already on the compiler's output — carried so the board can derive
      // matchedHighPriorityTopics/matchedPosition without a second watchlist read.
      position: t.position,
      keywords: t.keywords,
      synonyms: t.synonyms,
      entities: t.entities,
      riskPhrases: t.riskPhrases,
      routableTerms: t.routableTerms,
    }));
    const termSet = new Set<string>();
    for (const t of topics) {
      for (const v of [...t.keywords, ...t.synonyms, ...t.entities, ...t.riskPhrases])
        termSet.add(v);
    }
    for (const a of compiled.issueAreas) termSet.add(a);
    return {
      topics,
      issueAreas: compiled.issueAreas,
      terms: Array.from(termSet),
      jurisdictions: compiled.jurisdictions,
    };
  }

  async compileTopicsForClients(
    host: TrackerBoardService,
    tenantId: string,
    clientIds: string[],
  ): Promise<Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>> {
    const out = new Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>();
    if (!clientIds.length) return out;
    const watchlistIds = clientIds.map((c) => `wl:${c}`);

    const [watchlists, topics] = await host['prisma'].withTenant(tenantId, (tx) =>
      Promise.all([
        tx.watchlist.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          select: { clientId: true, issueAreas: true },
        }),
        tx.watchlistTopic.findMany({
          where: { tenantId, watchlistId: { in: watchlistIds } },
          select: {
            id: true,
            watchlistId: true,
            label: true,
            issueArea: true,
            position: true,
            priority: true,
          },
        }),
      ]),
    );
    const topicIds = topics.map((t) => t.id);
    const terms = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.watchlistTerm.findMany({
        where: {
          tenantId,
          watchlistId: { in: watchlistIds },
          OR: [...(topicIds.length ? [{ topicId: { in: topicIds } }] : []), { topicId: null }],
        },
        select: {
          watchlistId: true,
          topicId: true,
          termType: true,
          value: true,
          weight: true,
          id: true,
        },
      }),
    );

    const { issueAreasByClient, topicsByWatchlist, termsByTopicId, flatTermsByWatchlist } =
      this.groupBatchInputs(watchlists, topics, terms);
    this.compileClientTopics(
      clientIds,
      issueAreasByClient,
      topicsByWatchlist,
      termsByTopicId,
      flatTermsByWatchlist,
      out,
    );

    return out;
  }

  private groupBatchInputs(watchlists: BatchWatchlist[], topics: BatchTopic[], terms: BatchTerm[]) {
    const issueAreasByClient = new Map(watchlists.map((w) => [w.clientId, w.issueAreas]));
    const topicsByWatchlist = new Map<string, typeof topics>();
    for (const t of topics) {
      const arr = topicsByWatchlist.get(t.watchlistId) ?? [];
      arr.push(t);
      topicsByWatchlist.set(t.watchlistId, arr);
    }
    const termsByTopicId = new Map<string, typeof terms>();
    const flatTermsByWatchlist = new Map<string, typeof terms>();
    for (const term of terms) {
      if (term.topicId) {
        const arr = termsByTopicId.get(term.topicId) ?? [];
        arr.push(term);
        termsByTopicId.set(term.topicId, arr);
      } else {
        const arr = flatTermsByWatchlist.get(term.watchlistId) ?? [];
        arr.push(term);
        flatTermsByWatchlist.set(term.watchlistId, arr);
      }
    }

    return { issueAreasByClient, topicsByWatchlist, termsByTopicId, flatTermsByWatchlist };
  }

  private compileClientTopics(
    clientIds: string[],
    issueAreasByClient: Map<string, string[]>,
    topicsByWatchlist: Map<string, BatchTopic[]>,
    termsByTopicId: Map<string, BatchTerm[]>,
    flatTermsByWatchlist: Map<string, BatchTerm[]>,
    out: Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>,
  ): void {
    for (const clientId of clientIds) {
      const wlId = `wl:${clientId}`;
      const clientTopics = topicsByWatchlist.get(wlId) ?? [];
      const compilerTopics: CompilerTopic[] = clientTopics.map((t) => ({
        id: t.id,
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
      }));
      const compilerTerms: CompilerTerm[] = clientTopics.flatMap((t) =>
        (termsByTopicId.get(t.id) ?? []).map((term) => ({
          termType: term.termType,
          value: term.value,
          weight: term.weight,
          topicLabel: t.label,
          topicPriority: t.priority,
          termId: term.id,
        })),
      );
      // §4.3 fold — mirrors getWatchlist: merge flat terms into the existing
      // reserved-label topic if one exists, else synthesize it.
      const flat = flatTermsByWatchlist.get(wlId) ?? [];
      if (flat.length) {
        const host = clientTopics.find((t) => isReservedTopicLabel(t.label));
        const hostLabel = host?.label ?? HEARING_TERMS_TOPIC_LABEL;
        const hostPriority = host?.priority ?? 'med';
        if (!host) {
          compilerTopics.push({
            label: hostLabel,
            issueArea: null,
            position: 'monitor',
            priority: hostPriority,
          });
        }
        for (const term of flat) {
          compilerTerms.push({
            termType: term.termType,
            value: term.value,
            weight: term.weight,
            topicLabel: hostLabel,
            topicPriority: hostPriority,
            termId: term.id,
          });
        }
      }
      const compiled = compileWatchlist({
        issueAreas: issueAreasByClient.get(clientId) ?? [],
        topics: compilerTopics,
        terms: compilerTerms,
      });
      const topicsForFit: CompiledTopicForFit[] = compiled.billMatchSet.map((t) => ({
        id: t.id,
        label: t.label,
        issueArea: t.issueArea,
        priority: t.priority,
        position: t.position,
        keywords: t.keywords,
        synonyms: t.synonyms,
        entities: t.entities,
        riskPhrases: t.riskPhrases,
        routableTerms: t.routableTerms,
      }));
      out.set(clientId, {
        topics: topicsForFit,
        issueAreas: issueAreasByClient.get(clientId) ?? [],
      });
    }
  }
}
