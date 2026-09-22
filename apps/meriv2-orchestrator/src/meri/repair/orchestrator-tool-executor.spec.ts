import { buildClaimLedgerFromToolResults, ledgerToToolResultMap } from '@capiro/meriv2-core';
import { validateCitationMarkers, validateFormBCitations } from '@capiro/shared';
import { createOrchestratorToolExecutor, projectRemedyArgs } from './orchestrator-tool-executor';

const schema = {
  name: 'get_bill_status',
  input_schema: { properties: { billId: {}, clientId: {} }, required: ['billId'] },
};

function registry(readOnly = true, metadata = true) {
  return {
    get: jest.fn(() => ({ readOnly })),
    executionMetadata: jest.fn(() => metadata ? { executionMode: 'read' } : undefined),
  } as never;
}

describe('orchestrator repair tool executor', () => {
  it('projects governed identities and refuses unfillable required fields', () => {
    expect(projectRemedyArgs(
      { name: schema.name, args: { claimIds: ['c'] } }, schema,
      { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
    )).toEqual({ billId: '119-hr-1' });
    expect(projectRemedyArgs(
      { name: schema.name, args: { claimIds: ['c'] } }, schema,
      { tenantId: 'tenant' },
    )).toBeNull();
  });

  it.each([
    ['PE code', 'peCode', '0601234A'],
    ['award PIID', 'piid', 'FA1234-26-C-0001'],
    ['document id', 'documentId', 'doc-7'],
    ['opportunity id', 'opportunityId', 'opp-9'],
    ['committee', 'committeeId', 'HSAS'],
    ['bill', 'billId', '119-hr-1'],
  ])('projects the %s family only from governed identities', (_family, field, value) => {
    const familySchema = {
      name: `family_${field}`,
      input_schema: { properties: { [field]: {} }, required: [field] },
    };
    expect(projectRemedyArgs(
      { name: familySchema.name, args: { claimIds: ['c'] } },
      familySchema,
      { tenantId: 'tenant', identities: { [field]: value } },
    )).toEqual({ [field]: value });
    expect(projectRemedyArgs(
      { name: familySchema.name, args: { claimIds: ['c'] } },
      familySchema,
      { tenantId: 'tenant' },
    )).toBeNull();
  });

  it('refuses an unfillable schema with no_concrete_route rather than guessing', async () => {
    const invoke = jest.fn();
    const executor = createOrchestratorToolExecutor({
      registry: registry(), schemas: [schema], context: { tenantId: 'tenant' },
      citations: [], ledgerEntries: [], invoke,
    });
    await expect(executor.execute({ name: schema.name, args: {} }, {})).resolves.toMatchObject({
      ok: false,
      reason: 'no_concrete_route',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', undefined, true],
    ['write', false, true],
    ['missing metadata', true, false],
  ])('refuses %s tools', async (_label: string, readOnly: boolean | undefined, metadata: boolean) => {
    const invoke = jest.fn();
    const executor = createOrchestratorToolExecutor({
      registry: readOnly === undefined ? { get: () => undefined, executionMetadata: () => undefined } as never : registry(readOnly, metadata),
      schemas: [schema], context: { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
      citations: [], ledgerEntries: [], invoke,
    });
    expect(await executor.execute({ name: schema.name, args: {} }, {})).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('registers projected evidence with a stable citation marker', async () => {
    const citations: import('@capiro/shared').MeriCitation[] = [];
    const ledgerEntries: import('@capiro/meriv2-core').LedgerEntry[] = [];
    const executor = createOrchestratorToolExecutor({
      registry: registry(), schemas: [schema],
      context: { tenantId: 'tenant', identities: { billId: '119-hr-1' } },
      citations,
      ledgerEntries,
      invoke: async () => ({ data: [{ id: '119-hr-1', title: 'H.R. 1', url: 'https://example.test/hr1', snippet: 'Status: Enacted' }] }),
    });
    const result = await executor.execute({ name: schema.name, args: {} }, {});
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({ ok: true, evidence: [expect.objectContaining({ locator: '[1]' })] });
    expect(citations).toHaveLength(1);
    expect(ledgerEntries).toEqual([expect.objectContaining({
      tool: schema.name,
      result: expect.any(Object),
      rowCount: 1,
    })]);

    const marker = `[S:${schema.name}:119-hr-1]`;
    const revised = `H.R. 1 was enacted [1] ${marker}.`;
    const formA = validateCitationMarkers(revised, citations);
    const formB = validateFormBCitations(formA.cleanedText, ledgerToToolResultMap(ledgerEntries));
    expect(formB).toMatchObject({ invalid: [], valid: [marker], sanitizedText: revised });
    const claimLedger = buildClaimLedgerFromToolResults({
      output: formB.sanitizedText,
      ledgerEntries,
      citations,
    });
    expect(claimLedger.claims.flatMap((claim) => claim.sourceIds)).toEqual(expect.arrayContaining([
      'citation:1:get_bill_status:119-hr-1',
    ]));

    const withoutRegistration = validateFormBCitations(formA.cleanedText, {});
    expect(withoutRegistration.invalid).toEqual([marker]);
    expect(withoutRegistration.sanitizedText).not.toContain(marker);
  });
});
