import type { ControlledReadFixtureProof } from './meri-controlled-read-fixture.js';
import {
  fundingClaimsForModel,
  modelBudgetLineMetadata,
} from './meri-defense-budget-tool.helpers.js';

/** Called only after the existing controlled owner and current access checks.
 * Pure shape construction does not authorize a call or activate a live case. */
export function createControlledBudgetToolResult(
  proof: ControlledReadFixtureProof,
  tool: string,
  input: Record<string, unknown>,
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const fail = (): never => {
    throw new Error('meri_controlled_budget_selector_unsupported');
  };
  if (!['21', '22', '23', '24', '26', '27'].includes(proof.caseId)) fail();
  const search = tool === 'search_program_elements';
  const negative = proof.caseId === '27';
  const code = negative ? '0999999Z' : proof.caseId === '26' ? '0912346T' : '0912345T';
  const allowed = search
    ? ['query', 'q', 'limit', 'page', ...(negative ? ['service'] : [])]
    : ['peCode'];
  if (
    !['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'].includes(tool) ||
    (negative && !search) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    (search
      ? (input.query ?? input.q) !== code ||
        (input.page !== undefined && input.page !== 1) ||
        (input.limit !== undefined &&
          (!Number.isInteger(input.limit) ||
            Number(input.limit) < 1 ||
            Number(input.limit) > 50)) ||
        (negative && input.service !== 'Navy')
      : input.peCode !== code)
  )
    fail();
  const reads = proof.definition.reads;
  if (!reads.length) fail();
  const records = reads.map((read) => ({
    id: read.physicalId,
    sourceId: read.physicalId,
    sourceVersion: read.version,
    title: read.logicalId,
    section: read.facts.page ? `page ${read.facts.page}` : read.logicalId,
    ...(read.facts.page ? { page: read.facts.page } : {}),
    text: read.content,
    contentSha256: read.contentSha256,
    source: { recordId: read.physicalId, version: read.version, kind: read.kind },
    controlled: true,
    // Keep category natural keys and original units. Never flatten to one amount.
    ...(read.kind === 'budget_row'
      ? { naturalKey: read.facts.naturalKey, amountUsd: read.facts.amountUsd }
      : {}),
  }));
  const sourceReads = reads.map((read) => ({
    sourceId: read.physicalId,
    logicalSourceId: read.logicalId,
    sourceVersion: read.version,
    contentSha256: read.contentSha256,
    sourceTenantId: proof.tenantId,
    sourceClientId: null,
  }));
  const coverage = proof.definition.coverage ?? null;
  const base = {
    tool,
    records,
    controlledRead: { ...provenance, sourceReads, coverage },
    ...(coverage ? { coverage } : {}),
  };
  if (negative) return { ...base, data: [], total: 0, page: 1, limit: input.limit ?? 20 };
  const fiscalYears = [
    ...new Set(reads.map((r) => r.facts.fiscalYear).filter(Number.isInteger)),
  ] as number[];
  const years = fiscalYears.map((fy) => {
    const request = reads.find((r) => r.facts.fiscalYear === fy && r.kind === 'budget_document');
    const enacted = reads.find(
      (r) => r.facts.fiscalYear === fy && r.kind === 'enacted_appropriation',
    );
    return {
      fy,
      ...(request ? { request: request.facts.amountUsd / 1_000_000 } : {}),
      ...(enacted ? { enacted: enacted.facts.amountUsd / 1_000_000 } : {}),
    };
  });
  const claims = fundingClaimsForModel(years, fiscalYears.length ? Math.max(...fiscalYears) : null);
  const identity = modelBudgetLineMetadata({
    peCode: code,
    appropriationType: 'RDT&E',
    budgetActivity: null,
    lineType: null,
  });
  const programElement = {
    peCode: code,
    title: `Controlled synthetic PE ${code}`,
    ...identity,
    years: claims.years,
  };
  return {
    ...base,
    ...identity,
    peCode: code,
    currentCycleFy: claims.currentCycleFy,
    currentFundingClaim: claims.currentFundingClaim,
    // Frozen reports specify chamber/stage, not an authorizing/appropriating committee.
    reportRecommendations: reads
      .filter((r) => ['house_report', 'senate_committee_report'].includes(r.kind))
      .map((r) => ({
        sourceId: r.physicalId,
        fiscalYear: r.facts.fiscalYear,
        stage: r.facts.stage,
        amountUsd: r.facts.amountUsd,
      })),
    ...(search
      ? { data: [programElement], total: 1, page: 1, limit: input.limit ?? 20 }
      : tool === 'get_program_element'
        ? { programElement }
        : { years: claims.years }),
  };
}
