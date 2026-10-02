import { createHash } from 'node:crypto';
import { frozenFixture } from '../fixture.mjs';
import { cases } from '../cases.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, ownedIdentity } from './contract.mjs';

export const CONTROLLED_BUDGET_CASES = Object.freeze(['21', '22', '23', '24', '26', '27']);
const sets = Object.freeze({
  21: ['ENACT-26', 'R2-27'],
  22: ['HOUSE-27', 'SENATE-27'],
  23: ['R2-27', 'HOUSE-27', 'SENATE-27'],
  24: ['ENACT-26', 'R2-27'],
  26: ['PE-0912346T-ROW-A', 'PE-0912346T-ROW-B'],
  27: ['FY27-NAVY-BOOK'],
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const fail = () => {
  throw new Error('CONTROLLED_BUDGET_DEFINITION_INVALID');
};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Source-owned synthetic passages; no parsed PDF or shared corpus row is claimed.
 * This definition supplies data, never live activation or current authorization. */
export function createControlledBudgetDefinition({ caseId, tenantId, clientId, captureRunId }) {
  if (
    !CONTROLLED_BUDGET_CASES.includes(caseId) ||
    tenantId !== AUTHORIZED_TENANTS.T1.id ||
    !UUID.test(clientId ?? '') ||
    !UUID.test(captureRunId ?? '')
  )
    fail();
  const row = cases.find((c) => c.id === caseId);
  const ids = sets[caseId];
  if (JSON.stringify(row?.requiredSources) !== JSON.stringify(ids)) fail();
  const sourceMap = {};
  const reads = ids.map((logicalId) => {
    const original = frozenFixture.sources[logicalId];
    if (!original?.synthetic || original.tenantId !== 'T1' || original.clientId !== null) fail();
    const f = structuredClone(original.facts);
    let content;
    if (original.kind === 'budget_row') {
      if (
        f.peCode !== '0912346T' ||
        !['cost-category-a', 'cost-category-b'].includes(f.naturalKey) ||
        f.amountUsd !== (logicalId.endsWith('A') ? 6178000 : 2811000)
      )
        fail();
      content = `${logicalId}. PE ${f.peCode}. Natural key ${f.naturalKey}: ${f.displayAmount}.`;
    } else if (original.kind === 'complete_budget_index') {
      if (
        f.fiscalYear !== 2027 ||
        f.service !== 'Navy' ||
        f.complete !== true ||
        JSON.stringify(f.absentPeCodes) !== JSON.stringify(['0999999Z'])
      )
        fail();
      content = `${logicalId}. Complete indexed FY27 Navy book: no PE 0999999Z match.`;
    } else {
      const exact = {
        'R2-27': [2027, 'President’s Budget request', 42000000, '$42M'],
        'HOUSE-27': [2027, 'House report recommendation', 48000000, '$48M'],
        'SENATE-27': [2027, 'Senate committee report recommendation', 45000000, '$45M'],
        'ENACT-26': [2026, 'enacted', 37000000, '$37M'],
      }[logicalId];
      if (
        !exact ||
        f.peCode !== '0912345T' ||
        JSON.stringify([f.fiscalYear, f.stage, f.amountUsd, f.displayAmount]) !==
          JSON.stringify(exact) ||
        (logicalId === 'R2-27' && f.page !== 14)
      )
        fail();
      content = `${logicalId}${f.page ? `, page ${f.page}` : ''}. PE ${f.peCode}. FY${String(f.fiscalYear).slice(-2)} ${f.stage}: ${f.displayAmount}.`;
    }
    const physicalId = ownedIdentity(
      logicalId,
      tenantId,
      'controlled_read_adapter',
      frozenFixture.version,
      captureRunId,
    ).physicalId;
    sourceMap[logicalId] = {
      frozenFixtureId: logicalId,
      physicalId,
      tenantPhysicalId: tenantId,
      clientPhysicalId: null,
      kind: original.kind,
      version: 'v1',
    };
    return {
      logicalId,
      physicalId,
      kind: original.kind,
      version: 'v1',
      content,
      contentSha256: hash(content),
      facts: f,
    };
  });
  const sourceIds = reads.map((r) => r.physicalId);
  // Absence is an explicit original fixture assertion, not inference from an
  // omitted fetch or a live government's corpus.
  if (caseId === '23' && !row.exactFacts.includes('No FY27 enactment is established.')) fail();
  const coverage =
    caseId === '23'
      ? {
          kind: 'budget_stage_catalog',
          complete: true,
          peCode: '0912345T',
          fiscalYear: 2027,
          enactedSourcePresent: false,
          sourceIds,
        }
      : caseId === '27'
        ? {
            kind: 'budget_index',
            complete: true,
            fiscalYear: 2027,
            service: 'Navy',
            queriedPeCode: '0999999Z',
            matchCount: 0,
            sourceIds,
          }
        : null;
  return freeze({
    schemaVersion: 1,
    owner: 'meri_controlled_read_v1',
    fixtureVersion: frozenFixture.version,
    caseId,
    tenantId,
    clientId,
    captureRunId,
    sourceMap,
    physicalMapSha256: sha256Stable(sourceMap),
    reads,
    coverage,
  });
}
