import {
  projectRetainedClientContext03,
  RETAINED_CLIENT_CONTEXT_OPERATION_03,
  type ClientContextProjection03Input,
} from './retained-client-context';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import profileSchema from './retained-source-v02/client-context-profile-v03.schema.json';
import { RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE } from './retained-source-v02/client-context';
import { readRetainedSourceV02 } from './retained-source-v02/receiver';
import type { RetainedSourceV02Admission } from './retained-source-v02/admission';
import { MeriToolsService } from './meri-tools.service';
import { withMeriToolExecutionControl } from './meri-tool-request-control';
import type { TenantContext } from '@capiro/shared';
import { CLIENT_PROFILE_SECTIONS } from './meri-client-context.helpers';

const gatewayAsOf = '2026-10-18T12:00:00.000Z';
const startedAt = '2026-10-18T12:00:01.000Z';
const sourceAt = '2026-10-18T12:00:02.000Z';
const completedAt = '2026-10-18T12:00:03.000Z';
const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const fillerId = '33333333-3333-4333-8333-333333333333';
const defs = profileSchema.$defs as Record<string, Record<string, any>>;

/** Build only scalar boilerplate from Meri's byte-pinned schema. */
function fields(schemaOrName: string | Record<string, any>): any {
  const schema = typeof schemaOrName === 'string' ? defs[schemaOrName] : schemaOrName;
  if (schema.$ref) return schema.$ref.startsWith('#/$defs/') ? fields(schema.$ref.split('/').at(-1)!) : null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return schema.anyOf.some((part: Record<string, unknown>) => part.type === 'null')
    ? null : fields(schema.anyOf[0]);
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map((key: string) =>
    [key, fields(schema.properties[key])]));
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return schema.format === 'uuid' ? fillerId :
    schema.format === 'date-time' ? sourceAt : 'synthetic';
  if (schema.type === 'boolean') return false;
  return 0;
}

function fixture(): ClientContextProjection03Input {
  const client = { ...fields('ProfileClient'), id: clientId, tenantId, name: 'Synthetic', status: 'active' };
  const profileSections = Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((section) => [section, {
    status: 'complete', total: 0, returned: 0, limit: 25, truncated: false,
    nextCursor: null, representation: 'summary',
    source: { tool: 'get_client_context', clientId, section },
  }]));
  const profile = Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((section) => [section, []]));
  const profileSources = Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((section) => [section, []]));
  return {
    operation: { ...RETAINED_CLIENT_CONTEXT_OPERATION_03 },
    source: {
      tool: 'get_client_context', generatedAt: sourceAt,
      profileSections, coverageNote: RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE, profile, profileSources,
      context: {
        client, recentActivity: [], keyStakeholders: [], openThreads: [], openTasks: [],
        summary: { meetings: 0, mailThreads: 0, contacts: 0, openTasks: 0 },
      },
    },
    readWindow: { startedAt, completedAt },
    gatewayAsOf,
    expectedTenantId: tenantId,
    expectedClientId: clientId,
    clientResolution: { selector: clientId, clientId },
    normalizedInput: { clientId, section: null, afterId: null, limit: 25, representation: 'summary' },
    assertOutput03: jest.fn(),
  };
}

describe('retained client-context 0.3.0 projection', () => {
  it('pins the exact Meri PR160 0.3 schema bytes', () => {
    const bytes = readFileSync(join(__dirname, 'retained-source-v02', 'client-context-profile-v03.schema.json'));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('7d422f92a4771b2d7e869e45371396c12b8a69934f9cb8ca50f5821ccab514a2');
  });

  it('reports Core collection time while preserving the distinct gateway observation in validation', () => {
    const input = fixture();
    const result = projectRetainedClientContext03(input);
    expect(result.generatedAt).toBe(completedAt);
    expect(result.readWindow).toEqual({ startedAt, completedAt });
    expect((input.source as { generatedAt: string }).generatedAt).toBe(sourceAt);
    expect(input.gatewayAsOf).toBe(gatewayAsOf);
    expect(input.assertOutput03).toHaveBeenCalledWith(result, {
      operation: RETAINED_CLIENT_CONTEXT_OPERATION_03,
      gatewayAsOf, tenantId, clientId,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.readWindow)).toBe(true);
  });

  it('releases a complete schema-valid profile from one current owner call through the receiver', async () => {
    const input = fixture();
    const ownerRead = jest.fn().mockResolvedValue({ result: input.source, readWindow: input.readWindow });
    const tools = { readRetainedClientContextSourceV03: ownerRead } as unknown as MeriToolsService;
    const admission = {
      operation: input.operation,
      binding: { tenantId },
      clientId,
      input: input.normalizedInput,
      normalizationContext: { asOf: gatewayAsOf, clientResolution: input.clientResolution },
    } as unknown as RetainedSourceV02Admission;
    const result = await readRetainedSourceV02(admission, { tenantId } as TenantContext, tools);
    expect(ownerRead).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      tool: 'get_client_context', generatedAt: completedAt,
      readWindow: { startedAt, completedAt },
      context: { client: { id: clientId, tenantId } },
    });
  });

  it('releases the canonical profile without the internal account-owner version', async () => {
    const input = fixture();
    const expectedContext = (input.source as any).context;
    const context = {
      ...expectedContext,
      client: { ...expectedContext.client, accountOwnerVersion: 7 },
    };
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, {
      ensureClientVisible: jest.fn(async () => clientId),
      prisma: { withTenantUser: jest.fn(async () => []) },
      engagement: { clientContext: jest.fn(async () => context) },
      clientCapabilities: {
        listCapabilities: jest.fn(async () => []), listClientHistory: jest.fn(async () => []),
      },
      clientPeople: { listPeople: jest.fn(async () => []) },
      clientFacilities: { listFacilities: jest.fn(async () => []) },
      clientAdvocacy: {
        listMatters: jest.fn(async () => []),
        listRecords: jest.fn(async () => ({ items: [], total: 0, hasMore: false })),
      },
    });
    const deadlineAt = Date.now() + 30_000;
    const admission = {
      operation: input.operation,
      binding: { tenantId, actorId: fillerId },
      subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId: fillerId },
      clientId, input: input.normalizedInput, hardExpiryMs: deadlineAt,
      normalizationContext: { asOf: gatewayAsOf, clientResolution: input.clientResolution },
    } as unknown as RetainedSourceV02Admission;
    const result = await withMeriToolExecutionControl(
      { signal: new AbortController().signal, deadlineAt },
      () => readRetainedSourceV02(admission, { tenantId, userId: fillerId } as TenantContext, service),
    );
    expect(result).toMatchObject({ tool: 'get_client_context', context: expectedContext });
    expect((result as any).context.client).not.toHaveProperty('accountOwnerVersion');
    expect(context.client.accountOwnerVersion).toBe(7);
  });

  it.each([
    { operation: { id: 'get_client_context', version: '0.2.0' } },
    { operation: { id: 'read_client_documents', version: '0.3.0' } },
    { operation: { id: 'get_client_context', version: '0.3.0', extra: true } },
  ])('refuses an operation other than exact get_client_context@0.3.0', ({ operation }) => {
    const input = fixture();
    input.operation = operation;
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(input.assertOutput03).not.toHaveBeenCalled();
  });

  it.each([
    { readWindow: { startedAt: '2026-10-18T12:00:02.500Z', completedAt } },
    { readWindow: { startedAt, completedAt: '2026-10-18T12:00:01.500Z' } },
    { readWindow: { startedAt, completedAt, invented: true } },
  ])('refuses unsupported or untruthful collection clocks', (change) => {
    const input = { ...fixture(), ...change } as ClientContextProjection03Input;
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(input.assertOutput03).not.toHaveBeenCalled();
  });

  it('keeps canonical gateway asOf independent from cross-host source clock order', () => {
    const input = fixture();
    input.gatewayAsOf = '2026-10-18T12:00:02.000Z';
    projectRetainedClientContext03(input);
    expect(input.assertOutput03).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ gatewayAsOf: '2026-10-18T12:00:02.000Z' }));
  });

  it('refuses noncanonical gateway asOf without comparing the two host clocks', () => {
    const input = fixture();
    input.gatewayAsOf = '2026-10-18T12:00:02Z';
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });

  it('refuses a foreign client or tenant before invoking the external validator', () => {
    for (const identity of [{ expectedClientId: 'foreign' }, { expectedTenantId: 'foreign' }]) {
      const input = { ...fixture(), ...identity };
      expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
      expect(input.assertOutput03).not.toHaveBeenCalled();
    }
  });

  it('refuses unexpected canonical wrapper fields and accessor effects', () => {
    const extra = fixture();
    extra.source = { ...(extra.source as Record<string, unknown>), unauthorized: true };
    expect(() => projectRetainedClientContext03(extra)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const accessor = fixture();
    let evaluated = false;
    Object.defineProperty(accessor.source, 'tool', {
      enumerable: true,
      get() { evaluated = true; return 'get_client_context'; },
    });
    expect(() => projectRetainedClientContext03(accessor)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    expect(evaluated).toBe(false);
  });

  it('validates the full nested PR160 output schema, including required client fields', () => {
    const missing = fixture();
    delete (missing.source as any).context.client.createdAt;
    expect(() => projectRetainedClientContext03(missing)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const extra = fixture();
    (extra.source as any).context.client.unsupported = true;
    expect(() => projectRetainedClientContext03(extra)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });

  it('ports Meri section completeness and selected-client semantic checks', () => {
    const partial = fixture();
    Object.assign((partial.source as any).profileSections.capabilities, {
      status: 'partial', total: 1, truncated: true, nextCursor: null,
    });
    expect(() => projectRetainedClientContext03(partial)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const archived = fixture();
    (archived.source as any).context.client.status = 'archived';
    expect(() => projectRetainedClientContext03(archived)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    const unavailable = fixture();
    Object.assign((unavailable.source as any).profileSections.people, {
      status: 'unavailable', total: 0, truncated: null, error: 'section_unavailable',
    });
    expect(() => projectRetainedClientContext03(unavailable)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });

  it('binds cursor continuation to the admitted section and selected client', () => {
    const input = fixture();
    input.normalizedInput = { clientId, section: 'capabilities', afterId: null, limit: 1, representation: 'full' };
    const source = input.source as any;
    for (const section of CLIENT_PROFILE_SECTIONS) {
      Object.assign(source.profileSections[section], {
        status: section === 'capabilities' ? 'complete' : 'not_requested',
        total: section === 'capabilities' ? 0 : null,
        limit: 1, truncated: section === 'capabilities' ? false : null,
        representation: 'full',
      });
    }
    const row = { ...fields('ProfileClientCapability'), id: fillerId, tenantId, clientId };
    source.profile.capabilities = [row];
    source.profileSources.capabilities = [{ recordId: fillerId, updatedAt: row.updatedAt }];
    Object.assign(source.profileSections.capabilities, {
      status: 'partial', total: 2, returned: 1, truncated: true,
      nextCursor: Buffer.from(JSON.stringify({
        v: 1, clientId, section: 'capabilities', afterId: fillerId,
      })).toString('base64url'),
    });
    expect(projectRetainedClientContext03(input).profileSections).toBeDefined();
    const correctCursor = source.profileSections.capabilities.nextCursor;
    source.profileSections.capabilities.nextCursor = Buffer.from(JSON.stringify({
      v: 1, clientId: tenantId, section: 'capabilities', afterId: fillerId,
    })).toString('base64url');
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
    source.profileSections.capabilities.nextCursor = correctCursor;
    source.profile.capabilities = [{ ...fields('ProfileCapabilitiesSummary'), id: fillerId }];
    source.profileSources.capabilities = [{ recordId: fillerId }];
    expect(() => projectRetainedClientContext03(input)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });

  it('runs the pinned local validator without a callback and hides optional parity diagnostics', () => {
    const absent = fixture();
    absent.assertOutput03 = undefined as unknown as ClientContextProjection03Input['assertOutput03'];
    expect(projectRetainedClientContext03(absent).generatedAt).toBe(completedAt);
    const rejected = fixture();
    rejected.assertOutput03 = () => { throw new Error('private schema details'); };
    expect(() => projectRetainedClientContext03(rejected)).toThrow('CLIENT_CONTEXT_03_INVALID_RESULT');
  });
});
