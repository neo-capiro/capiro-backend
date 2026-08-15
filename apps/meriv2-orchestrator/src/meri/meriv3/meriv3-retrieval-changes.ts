import {
  actualClientId,
  attentionItem,
  clientNameFromContext,
  evidenceRows,
  opportunityPosture,
  parallelMapLimit,
  parseWindow,
  recipeCoverage,
  resultHasError,
  safeInvoke,
  stringValue,
  uniqueEvidence,
  withinWindow,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

function datedAndCarryover(
  sources: readonly SourceResult[],
  from: Date,
  to: Date,
) {
  const allEvidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 50)),
  );
  return {
    allEvidence,
    changes: allEvidence
      .filter((row) => withinWindow(row, from, to))
      .sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? '')),
    carryover: allEvidence.filter(
      (row) => !withinWindow(row, from, to) && attentionItem(row),
    ),
  };
}

export async function executeMeriClientChanges(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const clientRef = stringValue(input.clientId);
  if (!clientRef) {
    return {
      error: 'This recipe requires the server-pinned focused client id.',
      results: [],
    };
  }
  const window = parseWindow(input, ctx.plan);
  const clientContext = await safeInvoke(ctx.invoke, 'get_client_context', { clientId: clientRef });
  const realId = actualClientId(clientContext.result);
  const clientId = realId ?? clientRef;
  const clientName = clientNameFromContext(clientContext.result) ?? 'Selected client';
  const sources: SourceResult[] = [clientContext];
  sources.push(
    ...(await Promise.all([
      safeInvoke(ctx.invoke, 'query_tasks', { clientId, limit: 50 }),
      safeInvoke(ctx.invoke, 'query_action_items', { clientId, sort: 'priority', limit: 50 }),
      safeInvoke(ctx.invoke, 'query_outreach', { clientId, limit: 50 }),
      safeInvoke(ctx.invoke, 'list_emails', { clientId, limit: 50 }),
      safeInvoke(ctx.invoke, 'query_debriefs', { clientId }),
      safeInvoke(ctx.invoke, 'search_tracked_bills', { clientId }),
      ...(realId
        ? [safeInvoke(ctx.invoke, 'get_opportunity_client_context', { clientId: realId })]
        : []),
    ])),
  );

  const { changes, carryover } = datedAndCarryover(sources, window.from, window.to);
  const opportunitySource = sources.find(
    (source) => source.tool === 'get_opportunity_client_context',
  );
  const posture =
    realId && opportunitySource
      ? opportunityPosture(opportunitySource.result, realId, clientName)
      : null;
  const searched = resultHasError(clientContext.result) ? 0 : 1;
  const manifest = recipeCoverage(
    ['clients', 'mail', 'meetings', 'tasks', 'action_items', 'outreach', 'legislation'],
    sources,
    1,
    searched,
  );

  return {
    tool: 'query_client_changes',
    client: { id: realId ?? clientRef, name: clientName },
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      withinDays: window.withinDays,
    },
    summary: {
      datedChanges: changes.length,
      carryoverAttentionItems: carryover.length,
      opportunityPostureAvailable: Boolean(posture),
    },
    ...(posture ? { currentOpportunityPosture: [posture] } : {}),
    results: changes.slice(0, 80),
    carryoverAttention: carryover.slice(0, 30),
    coverage: manifest,
    note:
      manifest.complete
        ? 'All required supported sources were completely covered for the selected client and requested window.'
        : 'This selected-client change scan is partial. Do not confirm a negative statement such as “nothing happened” unless coverage.complete is true. Current opportunity posture is not labeled a change without a dated underlying record.',
  };
}

export async function executeMeriPortfolioChanges(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const window = parseWindow(input, ctx.plan);
  const activeClients = ctx.plan.activeClients;
  const scopedClients = activeClients.filter((client) => Boolean(client.id));
  const sources: SourceResult[] = await Promise.all([
    safeInvoke(ctx.invoke, 'query_tasks', { limit: 50 }),
    safeInvoke(ctx.invoke, 'query_action_items', { sort: 'priority', limit: 50 }),
    safeInvoke(ctx.invoke, 'query_outreach', { limit: 50 }),
    safeInvoke(ctx.invoke, 'list_emails', { limit: 50 }),
  ]);

  const fanout = await parallelMapLimit(scopedClients, 5, async (client) => {
    const clientContext = await safeInvoke(ctx.invoke, 'get_client_context', {
      clientId: client.id,
    });
    const realId = actualClientId(clientContext.result);
    const scopedId = realId ?? client.id!;
    const clientSources = [clientContext];
    clientSources.push(
      ...(await Promise.all([
        safeInvoke(ctx.invoke, 'query_debriefs', { clientId: scopedId }),
        safeInvoke(ctx.invoke, 'search_tracked_bills', { clientId: scopedId }),
        ...(realId
          ? [safeInvoke(ctx.invoke, 'get_opportunity_client_context', { clientId: realId })]
          : []),
      ])),
    );
    return {
      client,
      realId,
      sources: clientSources,
    };
  });
  sources.push(...fanout.flatMap((entry) => entry.sources));

  const { changes, carryover } = datedAndCarryover(sources, window.from, window.to);
  const opportunityPostures = fanout
    .map((entry) => {
      if (!entry.realId) return null;
      const source = entry.sources.find(
        (candidate) => candidate.tool === 'get_opportunity_client_context',
      );
      return source
        ? opportunityPosture(source.result, entry.realId, entry.client.name)
        : null;
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const clientCoverage = fanout.map((entry) => ({
    clientId: entry.realId ?? entry.client.id,
    clientName: entry.client.name,
    resolvedClientId: entry.realId,
    sourcesAttempted: entry.sources.map((source) => source.tool),
    failedSources: entry.sources
      .filter((source) => resultHasError(source.result))
      .map((source) => source.tool),
  }));
  const searchedClients = fanout.filter(
    (entry) => !resultHasError(entry.sources[0]?.result),
  ).length;
  const manifest = recipeCoverage(
    ['clients', 'mail', 'meetings', 'tasks', 'action_items', 'outreach', 'legislation'],
    sources,
    activeClients.length,
    searchedClients,
  );
  return {
    tool: 'query_portfolio_changes',
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      withinDays: window.withinDays,
    },
    summary: {
      activeClients: activeClients.length,
      clientsResolved: searchedClients,
      datedChanges: changes.length,
      carryoverAttentionItems: carryover.length,
      opportunityPostures: opportunityPostures.length,
    },
    clientCoverage,
    currentOpportunityPosture: opportunityPostures,
    results: changes.slice(0, 80),
    carryoverAttention: carryover.slice(0, 30),
    coverage: manifest,
    note:
      manifest.complete
        ? 'All authorized active clients and required supported sources were completely covered for this window.'
        : 'This portfolio scan is partial. Current opportunity posture is included where a client resolved to a UUID, but it is not labeled as a historical change unless the underlying record has a date in the requested window. Do not state that nothing changed across the portfolio unless coverage.complete is true.',
  };
}
