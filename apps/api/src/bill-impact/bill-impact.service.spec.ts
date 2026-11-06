import { BillImpactService, IMPACT_STATE_SQL, IMPACT_FEDERAL_SQL } from './bill-impact.service.js';
jest.mock('@capiro/shared', () => ({
  ...jest.requireActual('@capiro/shared'),
  recordAiUsageEvent: jest.fn(async () => undefined),
}));
const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'synthetic-clerk',
  role: 'standard_user',
  tenantSlug: 'fixture',
} as never;
const clientId = '00000000-0000-4000-8000-000000000003';
const input = { clientId, versionId: 'v1', revision: 'hash' };
function harness(federal = false) {
  const client = {
    id: clientId,
    name: 'Example',
    description: 'Manufactures composite aircraft structures for domestic defense programs.',
    productDescription: null,
  };
  const lifecycle = {
    title: 'Supplier qualification',
    latestAction: 'Laid on table; companion became law.',
    actionDate: '2026-04-01',
    sourceUrl: 'https://flsenate.gov/x',
  };
  const version: any = federal
    ? {
        id: 'v1',
        revision: 'hash',
        label: 'ih',
        sourceUrl: 'https://govinfo.gov/text',
        publishedDate: '2026-01-01',
        completeness: 'complete',
        text: 'Supplier qualification may be supported.\n\nThis does not appropriate funds.',
      }
    : {
        id: 'v1',
        revision: 'hash',
        label: 'Introduced',
        sourceUrl: 'https://flsenate.gov/text',
        publishedDate: '2026-01-01',
        coverage: 'complete_document',
        extractionState: 'extracted',
        sections: [
          {
            locator: 'Section 1',
            hash: 'x',
            text: 'Supplier qualification may be supported. This does not appropriate funds.',
          },
        ],
      };
  const profile = { facts: [] as any[], attachmentVisible: true };
  const authorization = {
    role: 'standard_user',
    memberActive: true,
    tenantActive: true,
    clerkUserId: 'synthetic-clerk',
    clientVisible: true,
    wallAllowed: true,
  };
  const currentMembership = () =>
    authorization.memberActive &&
    authorization.tenantActive &&
    authorization.clerkUserId === 'synthetic-clerk'
      ? { role: authorization.role }
      : null;
  const memberRead = jest.fn(async () => currentMembership());
  const clientRead = jest.fn(async () => (authorization.clientVisible ? client : null));
  const tenantQuery = jest.fn(async (sql: string) => {
    if (sql.includes('intel_feature_flag')) return [{ enabled: true }];
    if (sql.includes('FROM profile_fact')) return profile.facts;
    if (sql.includes('FROM engagement_attachments'))
      return profile.attachmentVisible ? [{ id: 'synthetic-attachment', prospectId: null }] : [];
    if (sql.includes('AS allowed')) return [{ allowed: authorization.wallAllowed }];
    return [];
  });
  const query = jest.fn(async (sql: string) =>
    sql.includes('legiwatch_research_document_source') || sql.includes('federal_evidence_current')
      ? [version]
      : [lifecycle],
  );
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: any) =>
      fn({
        $queryRawUnsafe: tenantQuery,
        $queryRaw: async (query: any) => {
          const sql = Array.isArray(query) ? query.join('') : query.text;
          if (sql.includes('FROM clients'))
            return authorization.clientVisible ? [{ version: 0, primary: null }] : [];
          if (sql.includes('FROM tenant_memberships'))
            return currentMembership() ? [currentMembership()] : [];
          return [];
        },
        tenantMembership: { findFirst: memberRead },
        client: { findFirst: clientRead },
        clientFacility: { findMany: async () => [] },
        clientCapability: { findMany: async () => [] },
        clientPortfolioProposal: { findMany: async () => [] },
        clientCapabilityTerm: { findMany: async () => [] },
        clientFacilityCapability: { findMany: async () => [] },
      }),
    ),
    $queryRawUnsafe: query,
  };
  const extract = jest
    .fn()
    .mockResolvedValueOnce({
      data: {
        impacts: [
          {
            evidenceIds: ['E1'],
            clientIds: ['C1'],
            possibleImplication: 'The client might review whether its composite products qualify.',
            assumptions: 'Funding and eligibility remain unverified.',
            verificationStep: 'Check requirements against the product specifications.',
          },
        ],
        limitations: 'Draft analysis of selected text only.',
      },
    })
    .mockResolvedValueOnce({
      data: { verdicts: [{ index: 0, supported: true }] },
    });
  const service = new BillImpactService(prisma as never, { extract } as never);
  return {
    service,
    client,
    lifecycle,
    version,
    tenantQuery,
    query,
    extract,
    profile,
    authorization,
    memberRead,
    clientRead,
  };
}
describe('bill impact review-only generation', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.LEGIWATCH_AGENT_PROVIDER = 'anthropic';
    process.env.LEGIWATCH_AGENT_MODEL = 'fixture';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  it('allows no supported client connection without fabricating a mandatory impact', async () => {
    const h = harness();
    h.extract.mockReset().mockResolvedValue({ data: { impacts: [] } });
    const result = await h.service.generate(ctx, 'fl-2026-hb1211', input);
    expect(result.impacts).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(h.extract).toHaveBeenCalledTimes(1);
    expect(result.limitations).toContain('require human review');
  });
  it('bounds the whole request and cancels provider work before the browser deadline', async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      let providerSignal: AbortSignal | undefined;
      h.extract.mockReset().mockImplementation((request: any) => {
        providerSignal = request.signal;
        return new Promise(() => undefined);
      });
      const pending = h.service.generate(ctx, 'fl-2026-hb1211', input);
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(145_000);
      await rejected;
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
  it.each([false, true])(
    'uses exact complete %s source without accepting browser-authored text',
    async (federal) => {
      const h = harness(federal);
      const id = federal ? '119-hr-10' : 'fl-2026-hb1211';
      const result = await h.service.generate(ctx, id, input);
      expect(result.reviewRequired).toBe(true);
      expect(result.version.revision).toBe('hash');
      expect(result.lifecycle.latestAction).toBe(h.lifecycle.latestAction);
      expect(h.extract).toHaveBeenCalledTimes(2);
      expect(h.query).toHaveBeenCalledWith(
        federal ? IMPACT_FEDERAL_SQL : IMPACT_STATE_SQL,
        ...[id, ...(!federal ? ['2026'] : [])],
      );
      expect(h.extract.mock.calls[0]![0].sources[0].text).toContain('does not appropriate funds');
      expect(h.extract.mock.calls[0]![0].runtime).toEqual({
        provider: 'anthropic',
        model: 'fixture',
      });
      expect(h.extract.mock.calls[0]![0].prompt).not.toContain('Manufactures composite');
      expect(h.extract.mock.calls[1]![0].instructions).toContain('Independently check');
    },
  );
  it('does not select a version automatically', async () => {
    const h = harness();
    await expect(
      h.service.generate(ctx, 'fl-2026-hb1211', { ...input, versionId: '' }),
    ).rejects.toThrow(/selected text/);
    expect(h.extract).not.toHaveBeenCalled();
  });
  it.each(['partial', 'metadata'])('withholds %s source before provider lookup', async (kind) => {
    const h = harness();
    if (kind === 'partial') h.version.coverage = 'partial';
    else h.version.sections = [];
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
      /complete retained/,
    );
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('rejects stale revision before generation', async () => {
    const h = harness();
    await expect(
      h.service.generate(ctx, 'fl-2026-hb1211', { ...input, revision: 'old' }),
    ).rejects.toThrow(/changed/);
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('requires meaningful client context before model work', async () => {
    const h = harness();
    h.client.description = 'Defense';
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/substantive/);
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('passes trusted tenant, current Clerk principal and client into the canonical access owner', async () => {
    const h = harness();
    await h.service.options(ctx, 'fl-2026-hb1211', clientId);
    expect(h.memberRead).toHaveBeenCalledWith({
      where: {
        tenantId: (ctx as any).tenantId,
        userId: (ctx as any).userId,
        status: 'active',
        user: { clerkUserId: 'synthetic-clerk' },
        tenant: { status: 'active' },
      },
      select: { role: true },
    });
    expect(h.clientRead).toHaveBeenCalledWith({
      where: { tenantId: (ctx as any).tenantId, id: clientId },
      select: { id: true, name: true },
    });
  });
  it('holds inaccessible clients before reading public evidence or calling model', async () => {
    const h = harness();
    h.authorization.clientVisible = false;
    await expect(h.service.options(ctx, 'fl-2026-hb1211', clientId)).rejects.toThrow(
      /Client not found/,
    );
    expect(h.query).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
  });
  it('honors an explicit disabled feature even for the internal tenant', async () => {
    const h = harness();
    h.tenantQuery.mockImplementation(async () => [{ enabled: false }]);
    await expect(h.service.options(ctx, 'fl-2026-hb1211', clientId)).rejects.toThrow(/unavailable/);
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['incomplete', 'refusal', 'unsupported'])(
    'withholds %s generation/review',
    async (mode) => {
      const h = harness();
      if (mode === 'unsupported')
        h.extract
          .mockReset()
          .mockResolvedValueOnce({
            data: {
              impacts: [
                {
                  evidenceIds: ['E1'],
                  clientIds: ['C1'],
                  possibleImplication: 'The client will receive a $50M award.',
                  assumptions: 'None.',
                  verificationStep: 'Spend the award.',
                },
              ],
              limitations: 'None.',
            },
          })
          .mockResolvedValueOnce({ data: { verdicts: [{ index: 0, supported: false }] } });
      else h.extract.mockReset().mockRejectedValue(new Error(mode));
      await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
        /could not be verified/,
      );
    },
  );
  it('rechecks client access after generation and withholds on revocation', async () => {
    const h = harness();
    h.extract.mockReset().mockImplementation(async () => {
      h.authorization.wallAllowed = false;
      return { data: { impacts: [] } };
    });
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
      /Client not found/,
    );
  });

  it.each(['role demotion', 'tenant deactivation', 'Clerk principal replacement'])(
    'withholds the draft after in-flight %s',
    async (reason) => {
      const h = harness();
      h.extract.mockReset().mockImplementation(async () => {
        if (reason === 'role demotion') h.authorization.role = 'guest';
        else if (reason === 'tenant deactivation') h.authorization.tenantActive = false;
        else h.authorization.clerkUserId = 'replacement-principal';
        return { data: { impacts: [] } };
      });
      await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(
        'Account owner access denied',
      );
      expect(h.extract).toHaveBeenCalledTimes(1);
      expect(h.memberRead).toHaveBeenCalledTimes(2);
    },
  );
  it('rechecks exact retained source after generation', async () => {
    const h = harness();
    let reads = 0;
    h.query.mockImplementation(async (sql) =>
      sql.includes('legiwatch_research_document_source')
        ? [{ ...h.version, revision: ++reads === 1 ? 'hash' : 'changed' }]
        : [h.lifecycle],
    );
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/changed/);
  });
  it('returns a safe conflict when the selected source is removed during generation', async () => {
    const h = harness();
    let reads = 0;
    h.query.mockImplementation(async (sql) =>
      sql.includes('legiwatch_research_document_source')
        ? ++reads === 1
          ? [h.version]
          : []
        : [h.lifecycle],
    );
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/changed/);
  });

  it('does not recover revoked source-backed prose from the client projection', async () => {
    const h = harness();
    const restricted =
      'Restricted source describes a proprietary supplier capability for defense manufacturing.';
    h.client.description = restricted;
    h.profile.facts = [
      {
        id: 'fact-description',
        fieldKey: 'description',
        value: restricted,
        origin: 'research',
        evidence: [{ attachmentId: 'synthetic-attachment' }],
        status: 'approved',
        isCurrent: true,
        version: 1,
      },
    ];
    h.profile.attachmentVisible = false;
    const options = await h.service.options(ctx, 'fl-2026-hb1211', clientId);
    expect(options.contextUnavailable).toMatch(/substantive/);
    expect(JSON.stringify(options)).not.toContain(restricted);
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/substantive/);
    expect(h.extract).not.toHaveBeenCalled();
  });

  it('retains visible profile context while excluding revoked evidence from the SDK sources', async () => {
    const h = harness();
    const restricted =
      'Restricted source describes a proprietary supplier capability for defense manufacturing.';
    h.client.description = restricted;
    (h.client as { productDescription: string | null }).productDescription =
      'Manufactures public catalog composite structures for domestic aircraft suppliers.';
    h.profile.facts = [
      {
        id: 'fact-description',
        fieldKey: 'description',
        value: restricted,
        origin: 'research',
        evidence: [{ attachmentId: 'synthetic-attachment' }],
        status: 'approved',
        isCurrent: true,
        version: 1,
      },
    ];
    h.profile.attachmentVisible = false;
    h.extract.mockReset().mockResolvedValue({ data: { impacts: [] } });
    const result = await h.service.generate(ctx, 'fl-2026-hb1211', input);
    expect(JSON.stringify(h.extract.mock.calls[0]![0])).not.toContain(restricted);
    expect(JSON.stringify(h.extract.mock.calls[0]![0].sources)).toContain('public catalog');
    expect(JSON.stringify(result)).not.toContain(restricted);
  });

  it('withholds a generated draft when its client source is revoked during model execution', async () => {
    const h = harness();
    h.profile.facts = [
      {
        id: 'fact-description',
        fieldKey: 'description',
        value: h.client.description,
        origin: 'research',
        evidence: [{ attachmentId: 'synthetic-attachment' }],
        status: 'approved',
        isCurrent: true,
        version: 1,
      },
    ];
    h.extract.mockReset().mockImplementation(async () => {
      h.profile.attachmentVisible = false;
      return { data: { impacts: [] } };
    });
    await expect(h.service.generate(ctx, 'fl-2026-hb1211', input)).rejects.toThrow(/changed/);
  });
});
