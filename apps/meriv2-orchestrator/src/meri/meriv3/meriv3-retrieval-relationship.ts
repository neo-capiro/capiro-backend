import {
  attentionItem,
  evidenceRows,
  executeMeriExternalEntityResolution,
  recipeCoverage,
  resolutionTerms,
  resolvedClientId,
  safeInvoke,
  sourceCount,
  stringValue,
  uniqueEvidence,
  actualClientId,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

export async function executeMeriRelationshipBrief(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const resolution = await executeMeriExternalEntityResolution(target, ctx.invoke);
  const canonical = resolution.resolvedEntity?.canonicalName ?? target;
  const terms = resolutionTerms(target, resolution);
  const withinDays =
    typeof input.withinDays === 'number'
      ? Math.min(Math.max(Math.floor(input.withinDays), 1), 3650)
      : undefined;
  const sources: SourceResult[] = [{ tool: 'resolve_entity', result: resolution }];

  const emailCalls = terms.slice(0, 4).map((term) =>
    safeInvoke(ctx.invoke, 'search_emails', {
      ...(term.includes('.') && !term.includes(' ') ? { participant: term } : { query: term }),
      ...(withinDays ? { withinDays } : {}),
      limit: 50,
    }),
  );
  const domain = resolution.resolvedEntity?.domains[0];
  sources.push(
    ...(await Promise.all([
      ...emailCalls,
      safeInvoke(ctx.invoke, 'find_contacts', {
        ...(domain ? { domain } : { query: canonical }),
        limit: 100,
      }),
      safeInvoke(ctx.invoke, 'search_research_sources', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_memory', {
        query: `relationship, decisions, commitments, promises, concerns, and history with ${canonical}`,
        k: 15,
      }),
    ])),
  );

  // Search-emails does not expose thread hydration by threadId. To recover more
  // of the relationship chronology without inventing a second mailbox reader,
  // use the top matched subjects as bounded thread-like follow-up searches.
  const matchedSubjects = [
    ...new Set(
      sources
        .filter((source) => source.tool === 'search_emails')
        .flatMap((source) => evidenceRows(source.tool, source.result, 12))
        .map((row) => row.title.trim())
        .filter((subject) => subject && !/^search_emails result/i.test(subject)),
    ),
  ].slice(0, 4);
  if (matchedSubjects.length) {
    sources.push(
      ...(await Promise.all(
        matchedSubjects.map((subject) =>
          safeInvoke(ctx.invoke, 'search_emails', {
            query: subject,
            ...(domain ? { participant: domain } : {}),
            ...(withinDays ? { withinDays } : {}),
            limit: 50,
          }),
        ),
      )),
    );
  }

  const clientRef = resolution.resolvedEntity?.clientId ?? resolvedClientId(resolution);
  let clientId: string | null = null;
  if (clientRef) {
    const clientContext = await safeInvoke(ctx.invoke, 'get_client_context', { clientId: clientRef });
    sources.push(clientContext);
    clientId = actualClientId(clientContext.result) ?? clientRef;
    sources.push(
      ...(await Promise.all([
        safeInvoke(ctx.invoke, 'list_emails', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'search_client_knowledge', {
          clientId,
          query: 'relationship people decisions commitments strategy recent work',
        }),
        safeInvoke(ctx.invoke, 'read_client_documents', { clientId }),
        safeInvoke(ctx.invoke, 'query_debriefs', { clientId }),
        safeInvoke(ctx.invoke, 'query_tasks', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'query_outreach', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'search_tracked_bills', { clientId }),
      ])),
    );
  }

  const evidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 12)),
  );
  const chronology = evidence
    .filter((row) => row.occurredAt)
    .sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? ''));
  const commitments = evidence.filter(
    (row) => row.sourceTool === 'query_tasks' && attentionItem(row),
  );
  const communications = evidence.filter((row) =>
    ['search_emails', 'list_emails'].includes(row.sourceTool),
  );
  const people = evidence.filter((row) => row.sourceTool === 'find_contacts');
  const documents = evidence.filter((row) =>
    ['search_client_knowledge', 'read_client_documents'].includes(row.sourceTool),
  );
  const manifest = recipeCoverage(
    ['identity', 'mail', 'contacts', 'internal_research', 'memory'],
    sources,
    1,
    resolution.resolutionStatus === 'not_found' ? 0 : 1,
  );
  return {
    tool: 'query_relationship_brief',
    subject: target,
    resolvedEntity: resolution.resolvedEntity,
    resolutionStatus: resolution.resolutionStatus,
    summary: {
      evidenceItems: evidence.length,
      communications: communications.length,
      people: people.length,
      openCommitments: commitments.length,
      documents: documents.length,
      threadLikeFollowups: matchedSubjects.length,
      firstObservedAt: chronology.at(-1)?.occurredAt ?? null,
      lastObservedAt: chronology[0]?.occurredAt ?? null,
    },
    chronology: chronology.slice(0, 50),
    openCommitments: commitments.slice(0, 20),
    people: people.slice(0, 20),
    communications: communications.slice(0, 30),
    documents: documents.slice(0, 20),
    sections: Object.fromEntries(
      [...new Set(sources.map((source) => source.tool))].map((tool) => [
        tool,
        sourceCount(sources, tool),
      ]),
    ),
    results: evidence.slice(0, 60),
    coverage: manifest,
    note:
      manifest.complete
        ? 'The synchronized sources used by this recipe were fully enumerated for the requested entity and window.'
        : 'The brief is evidence-rich but not exhaustive. Subject-based follow-up searches deepen matching conversations, while full durable relationship episodes remain a Knowledge Base responsibility. Inspect coverage before a negative claim.',
  };
}
