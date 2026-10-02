import { createHash } from 'node:crypto';
import { frozenFixture } from '../fixture.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, ownedIdentity } from './contract.mjs';
import {
  CONTROLLED_BUDGET_CASES,
  createControlledBudgetDefinition,
} from './controlled-budget-definitions.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = () => {
  throw new Error('CONTROLLED_READ_DEFINITION_SCOPE_INVALID');
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/** Immutable synthetic adapter sources. These are NOT shared budget rows, parsed
 * PDFs, client attachments, saved research runs, or current authorization proof.
 * Runtime admission must independently verify the signed current capture binding.
 */
export function createControlledReadDefinition({ caseId, tenantId, clientId, captureRunId }) {
  if (CONTROLLED_BUDGET_CASES.includes(caseId))
    return createControlledBudgetDefinition({ caseId, tenantId, clientId, captureRunId });
  if (
    !['20', '72', '74'].includes(caseId) ||
    tenantId !== AUTHORIZED_TENANTS.T1.id ||
    !UUID.test(clientId ?? '') ||
    !UUID.test(captureRunId ?? '')
  )
    fail();
  const parentId = { 20: 'R2-27', 72: 'MEMO-A-LATEST', 74: 'RESEARCH-RUN-74' }[caseId];
  const parent = structuredClone(frozenFixture.sources[parentId]);
  if (
    parent?.synthetic !== true ||
    parent.tenantId !== 'T1' ||
    parent.clientId !== (caseId === '20' ? null : 'ASTER')
  )
    fail();
  const sourceMap = {};
  const makeRead = (logicalId, content, kind = parent.kind) => {
    const physicalId = ownedIdentity(
      logicalId,
      tenantId,
      'controlled_read_adapter',
      frozenFixture.version,
      captureRunId,
    ).physicalId;
    sourceMap[logicalId] = {
      frozenFixtureId: parentId,
      physicalId,
      tenantPhysicalId: tenantId,
      clientPhysicalId: caseId === '20' ? null : clientId,
      kind,
      version: 'v1',
    };
    return {
      logicalId,
      physicalId,
      kind,
      version: 'v1',
      content,
      contentSha256: hash(content),
      facts: structuredClone(parent.facts),
    };
  };
  let reads;
  if (caseId === '20') {
    const f = parent.facts;
    if (
      parent.kind !== 'budget_document' ||
      f.peCode !== '0912345T' ||
      f.fiscalYear !== 2027 ||
      f.amountUsd !== 42000000 ||
      f.displayAmount !== '$42M' ||
      f.page !== 14 ||
      f.stage !== 'President’s Budget request'
    )
      fail();
    reads = [
      makeRead(
        parentId,
        `${parentId}, page ${f.page}. PE ${f.peCode}. FY${String(f.fiscalYear).slice(-2)} ${f.stage}: ${f.displayAmount}.`,
      ),
    ];
  } else if (caseId === '72') {
    if (
      parent.kind !== 'memo' ||
      parent.facts.repeated !== true ||
      parent.facts.adapterResponse?.httpStatus !== 200 ||
      parent.facts.adapterResponse?.body?.error !== 'document unavailable'
    )
      fail();
    reads = [makeRead(parentId, '')];
  } else {
    if (
      parent.kind !== 'durable_run_fixture' ||
      parent.facts.totalReads !== 4 ||
      parent.facts.completedBeforeWorkerKill !== 2 ||
      parent.facts.authorityChanged !== false
    )
      fail();
    reads = Array.from({ length: 4 }, (_, index) =>
      makeRead(
        `${parentId}:read:${index + 1}`,
        `Controlled synthetic evidence read ${index + 1} of 4 for ${parentId}.`,
        'controlled_research_evidence',
      ),
    );
  }
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
  });
}
