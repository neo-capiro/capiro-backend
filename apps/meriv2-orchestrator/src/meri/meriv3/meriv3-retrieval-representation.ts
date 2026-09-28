import {
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

/**
 * Deterministic Representation Lookup fan-out for "who represents
 * [district/state]?" — one intent, two tools: roster then representation
 * mapping. Districts and committees are different questions; committee and
 * acquisition staffing live in the Staff & Personnel Directory recipe.
 */
export async function executeMeriRepresentationLookup(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const clientId = stringValue(input.clientId) ?? ctx.plan.activeClients[0]?.id ?? null;
  const state = stringValue(input.state) ?? null;
  const chamber = stringValue(input.chamber) ?? null;

  const sources: SourceResult[] = [
    {
      tool: 'list_members',
      result: await safeInvoke(ctx.invoke, 'list_members', {
        ...(state ? { state } : {}),
        ...(chamber ? { chamber } : {}),
        limit: 100,
      }),
    },
  ];
  const members = sources[0] ?? {
    tool: 'list_members',
    result: { error: 'roster search did not run' },
  };

  // get_representation is client-scoped: only meaningful when we know whose
  // representation we are mapping. Skipped lanes are named, never silent.
  let representation: SourceResult | null = null;
  if (clientId) {
    representation = {
      tool: 'get_representation',
      result: await safeInvoke(ctx.invoke, 'get_representation', {
        clientId,
        ...(state ? { state } : {}),
      }),
    };
    sources.push(representation);
  }

  const rosterOk = !resultHasError(members.result) && resultRows(members.result).length > 0;
  const representationOk = representation
    ? !resultHasError(representation.result) && resultRows(representation.result).length > 0
    : false;

  return {
    tool: 'query_representation_lookup',
    clientId,
    state,
    results: sources.map((source) => ({ tool: source.tool, result: source.result })),
    coverageManifest: {
      requiredDomains: ['directory'],
      optionalDomains: [],
      searchedDomains: [...(rosterOk ? ['directory'] : [])],
      coverage: [
        { tool: 'list_members', checked: true, complete: rosterOk },
        {
          tool: 'get_representation',
          checked: Boolean(representation),
          complete: representationOk,
        },
      ],
      gaps: [
        ...(rosterOk ? [] : ['list_members']),
        ...(clientId
          ? representationOk
            ? []
            : ['get_representation']
          : ['get_representation (no client selected — roster only)']),
      ],
    },
  };
}
