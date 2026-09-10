import {
  isRecord,
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

function sourceHasEvidence(source: SourceResult): boolean {
  return !resultHasError(source.result) && resultRows(source.result).length > 0;
}

/**
 * Deterministic Hearing Watch fan-out for "what hearings should we care
 * about?" requests. Calendar-driven, unlike status-driven Bill Watch: one
 * committee-hearings search scoped to the client (when authorized), with the
 * composer picking up the LegiWatch handoff context (`lw:meri-context`
 * sessionStorage payload written by HearingActions) when the request
 * originates from a hearing.
 */
export async function executeMeriHearingWatch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const clientId = stringValue(input.clientId) ?? ctx.plan.activeClients[0]?.id ?? null;
  const committeeName = stringValue(input.committeeName) ?? null;
  const chamber = stringValue(input.chamber) ?? null;
  const hearingId = stringValue(input.hearingId) ?? null;

  const sources: SourceResult[] = [
    {
      tool: 'search_committee_hearings',
      result: await ctx.invoke('search_committee_hearings', {
        ...(clientId ? { clientId } : {}),
        ...(committeeName ? { committeeName } : {}),
        ...(chamber ? { chamber } : {}),
        ...(hearingId ? { hearingId } : {}),
        limit: 25,
      }),
    },
  ];
  const hearings: SourceResult = sources[0] ?? {
    tool: 'search_committee_hearings',
    result: { error: 'hearing search did not run' },
  };

  // LegiWatch handoff: when the request came from the LegiWatch composer
  // action, HearingActions stashed { packet, createdAt } under
  // `lw:meri-context`. Surfaces it in the manifest so the response can cite
  // the hearing the user was looking at instead of answering in a vacuum.
  const lwContext = isRecord(input.legiwatchContext) ? input.legiwatchContext : null;
  const lwHandoff = lwContext
    ? {
        source: 'legiwatch:hearing-actions',
        hearingId: stringValue(lwContext.hearingId),
        insightId: stringValue(lwContext.insightId),
      }
    : null;

  return {
    tool: 'query_hearing_watch',
    clientId,
    committeeName,
    hearingId,
    results: sources.map((source) => ({ tool: source.tool, result: source.result })),
    coverageManifest: {
      requiredDomains: ['hearings'],
      searchedDomains: sourceHasEvidence(hearings) ? ['hearings'] : [],
      coverage: [
        { tool: 'search_committee_hearings', checked: true, complete: sourceHasEvidence(hearings) },
      ],
      gaps: resultHasError(hearings.result) ? ['search_committee_hearings'] : [],
      legiwatchHandoff: lwHandoff,
      note:
        'Calendar-driven watch: run again near committee markups. For bill status, use Bill Watch — hearings and bills change on different clocks.',
    },
  };
}