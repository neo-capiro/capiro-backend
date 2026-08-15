const MAX_PRIMARY_RESULTS = 30;
const MAX_CARRYOVER_RESULTS = 10;
const MAX_COMPANY_RESULTS = 20;
const MAX_CHRONOLOGY_RESULTS = 30;
const MAX_SECTION_RESULTS = 12;
const MAX_PORTFOLIO_POSTURES = 40;
const MAX_VALIDATED_PE_RESULTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactArray(value: unknown, max: number): unknown {
  return Array.isArray(value) ? value.slice(0, max) : value;
}

function compactCompanySections(value: Record<string, unknown>) {
  const {
    coverage,
    results,
    publicCapabilities,
    historicalAwards,
    candidateOpportunities,
    candidateGrants,
    candidateProgramElements,
    validatedProgramElements,
    ...rest
  } = value;
  return {
    ...(coverage !== undefined ? { coverage } : {}),
    ...rest,
    ...(Array.isArray(publicCapabilities)
      ? { publicCapabilities: publicCapabilities.slice(0, 8) }
      : {}),
    ...(Array.isArray(historicalAwards)
      ? { historicalAwards: historicalAwards.slice(0, 10) }
      : {}),
    ...(Array.isArray(candidateOpportunities)
      ? { candidateOpportunities: candidateOpportunities.slice(0, 12) }
      : {}),
    ...(Array.isArray(candidateGrants)
      ? { candidateGrants: candidateGrants.slice(0, 8) }
      : {}),
    ...(Array.isArray(candidateProgramElements)
      ? { candidateProgramElements: candidateProgramElements.slice(0, 12) }
      : {}),
    ...(Array.isArray(validatedProgramElements)
      ? { validatedProgramElements: validatedProgramElements.slice(0, MAX_VALIDATED_PE_RESULTS) }
      : {}),
    ...(Array.isArray(results) ? { results: results.slice(0, MAX_COMPANY_RESULTS) } : {}),
  };
}

function compactCompanyResearch(value: unknown): unknown {
  return isRecord(value) ? compactCompanySections(value) : value;
}

/**
 * The Responses runtime bounds each tool result before returning it to the
 * model. Coverage must therefore appear before evidence arrays, otherwise a
 * large result could hide the very metadata that prevents false exhaustive
 * claims. This helper also caps evidence at a useful reasoning size while the
 * underlying governed calls retain their complete audit traces.
 */
export function compactMeriRetrievalRecipeResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const {
    coverage,
    results,
    carryoverAttention,
    companyResearch,
    chronology,
    openCommitments,
    people,
    communications,
    documents,
    currentOpportunityPosture,
    clientCoverage,
    publicCapabilities,
    historicalAwards,
    candidateOpportunities,
    candidateGrants,
    candidateProgramElements,
    validatedProgramElements,
    ...rest
  } = value;
  return {
    ...(coverage !== undefined ? { coverage } : {}),
    ...rest,
    ...(companyResearch !== undefined
      ? { companyResearch: compactCompanyResearch(companyResearch) }
      : {}),
    ...(publicCapabilities !== undefined
      ? { publicCapabilities: compactArray(publicCapabilities, 8) }
      : {}),
    ...(historicalAwards !== undefined
      ? { historicalAwards: compactArray(historicalAwards, 10) }
      : {}),
    ...(candidateOpportunities !== undefined
      ? { candidateOpportunities: compactArray(candidateOpportunities, 12) }
      : {}),
    ...(candidateGrants !== undefined
      ? { candidateGrants: compactArray(candidateGrants, 8) }
      : {}),
    ...(candidateProgramElements !== undefined
      ? { candidateProgramElements: compactArray(candidateProgramElements, 12) }
      : {}),
    ...(validatedProgramElements !== undefined
      ? { validatedProgramElements: compactArray(validatedProgramElements, MAX_VALIDATED_PE_RESULTS) }
      : {}),
    ...(chronology !== undefined
      ? { chronology: compactArray(chronology, MAX_CHRONOLOGY_RESULTS) }
      : {}),
    ...(openCommitments !== undefined
      ? { openCommitments: compactArray(openCommitments, MAX_SECTION_RESULTS) }
      : {}),
    ...(people !== undefined ? { people: compactArray(people, MAX_SECTION_RESULTS) } : {}),
    ...(communications !== undefined
      ? { communications: compactArray(communications, MAX_SECTION_RESULTS) }
      : {}),
    ...(documents !== undefined
      ? { documents: compactArray(documents, MAX_SECTION_RESULTS) }
      : {}),
    ...(currentOpportunityPosture !== undefined
      ? {
          currentOpportunityPosture: compactArray(
            currentOpportunityPosture,
            MAX_PORTFOLIO_POSTURES,
          ),
        }
      : {}),
    ...(clientCoverage !== undefined
      ? { clientCoverage: compactArray(clientCoverage, MAX_PORTFOLIO_POSTURES) }
      : {}),
    ...(Array.isArray(results) ? { results: results.slice(0, MAX_PRIMARY_RESULTS) } : {}),
    ...(Array.isArray(carryoverAttention)
      ? { carryoverAttention: carryoverAttention.slice(0, MAX_CARRYOVER_RESULTS) }
      : {}),
  };
}
