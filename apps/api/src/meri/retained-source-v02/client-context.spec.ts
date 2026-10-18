import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { CLIENT_PROFILE_SECTIONS } from '../meri-client-context.helpers.js';
import profileSchema from './client-context-profile.schema.json';
import {
  prepareRetainedClientContextV02,
  RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE,
} from './client-context.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const AS_OF = '2026-10-18T12:34:56.000Z';
const defs = profileSchema.$defs as Record<string, Record<string, any>>;

/** Deterministic schema-derived filler; assertions below change literal facts. */
function fields(schemaOrName: string | Record<string, any>): any {
  const schema = typeof schemaOrName === 'string' ? defs[schemaOrName] : schemaOrName;
  if (schema.$ref) {
    if (schema.$ref.startsWith('#/$defs/')) return fields(schema.$ref.split('/').at(-1)!);
    return null; // data-search KnowledgeJsonValue
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return schema.anyOf.some((item: Record<string, unknown>) => item.type === 'null')
    ? null : fields(schema.anyOf[0]);
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map((name: string) =>
    [name, fields(schema.properties[name])]));
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return schema.format === 'uuid' ? OTHER :
    schema.format === 'date-time' ? AS_OF : 'synthetic';
  if (schema.type === 'boolean') return false;
  return 0;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
}

function fixture(section: string | null = null, limit = 25) {
  const representation = section ? 'full' : 'summary';
  const profileSections = Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, {
    status: section && section !== name ? 'not_requested' : 'complete',
    total: section && section !== name ? null : 0,
    returned: 0,
    limit,
    truncated: section && section !== name ? null : false,
    nextCursor: null as string | null,
    representation,
    source: { tool: 'get_client_context', clientId: CLIENT, section: name },
  }]));
  const profile: Record<string, Record<string, unknown>[]> =
    Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, []]));
  const profileSources: Record<string, Record<string, unknown>[]> =
    Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, []]));
  const client = fields('ProfileClient');
  Object.assign(client, { id: CLIENT, tenantId: TENANT, name: 'Synthetic client', status: 'active' });
  const canonicalResult = {
    tool: 'get_client_context', generatedAt: AS_OF,
    profileSections,
    coverageNote: RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE,
    profile,
    profileSources,
    context: {
      client, recentActivity: [], keyStakeholders: [], openThreads: [], openTasks: [],
      summary: { meetings: 0, mailThreads: 0, contacts: 0, openTasks: 0 },
    },
  };
  return {
    request: { clientId: CLIENT, ...(section ? { section } : {}), limit },
    normalizedInput: { clientId: CLIENT, section, afterId: null, limit, representation },
    trusted: {
      tenantId: TENANT, selectedClientId: CLIENT, asOf: AS_OF,
      clientResolution: { selector: CLIENT, clientId: CLIENT },
    },
    canonicalResult,
    ownerReceipt: {
      tool: 'get_client_context', tenantId: TENANT, clientId: CLIENT,
      observedAt: AS_OF, resultSha256: digest(canonicalResult),
    },
  };
}

function reseal(args: ReturnType<typeof fixture>) {
  args.ownerReceipt.resultSha256 = digest(args.canonicalResult);
  return args;
}

describe('Core retained client-context 0.2 source preparation', () => {
  it('pins the exact Meri PR158 schemas used for AJV shape validation', () => {
    const root = __dirname;
    expect(createHash('sha256').update(readFileSync(join(root, 'client-context-profile.schema.json')))
      .digest('hex')).toBe('67ad0fd59fe7b995e5e9c73d60a82a12220c58d74a81672b485d9279458ba27d');
    expect(createHash('sha256').update(readFileSync(join(root, 'client-context-data-search.schema.json')))
      .digest('hex')).toBe('b390270625b4662df487f04b13df745f422d10a2a8aa90e79e90a7ce75219d60');
  });

  it('prepares a complete six-section canonical result with same-read receipt', () => {
    const args = fixture();
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'prepared', result: args.canonicalResult });
    expect(Object.keys(args.canonicalResult.profileSections)).toEqual([...CLIENT_PROFILE_SECTIONS]);
  });

  it('accepts the signed normalized input without inventing an untransmitted raw request', () => {
    const { request: _request, ...admitted } = fixture('capabilities');
    expect(prepareRetainedClientContextV02(admitted).kind).toBe('prepared');
    const widened = { ...admitted, normalizedInput: { ...admitted.normalizedInput, clientId: OTHER } };
    expect(prepareRetainedClientContextV02(widened))
      .toEqual({ kind: 'refused', reason: 'selection_mismatch' });
  });

  it('refuses a missing or independently substituted owner observation', () => {
    const args = fixture();
    expect(prepareRetainedClientContextV02({ ...args, ownerReceipt: undefined }))
      .toEqual({ kind: 'refused', reason: 'source_mismatch' });
    args.canonicalResult.generatedAt = '2026-10-18T12:34:57.000Z';
    reseal(args);
    args.ownerReceipt.observedAt = args.canonicalResult.generatedAt;
    expect(prepareRetainedClientContextV02(args))
      .toEqual({ kind: 'refused', reason: 'observation_mismatch' });
    expect(prepareRetainedClientContextV02({ ...args, trusted: { ...args.trusted, asOf: '' } }))
      .toEqual({ kind: 'refused', reason: 'trusted_context_missing' });
  });

  it('refuses result mutation after the owner minted the receipt', () => {
    const args = fixture();
    args.canonicalResult.context.client.name = 'Changed after read';
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'source_mismatch' });
  });

  it('refuses client selection, resolution, archived state, and tenant drift', () => {
    const args = fixture();
    expect(prepareRetainedClientContextV02({ ...args, trusted: {
      ...args.trusted, clientResolution: { selector: CLIENT, clientId: OTHER },
    } })).toEqual({ kind: 'refused', reason: 'trusted_context_missing' });
    expect(prepareRetainedClientContextV02({ ...args, request: { clientId: OTHER } }))
      .toEqual({ kind: 'refused', reason: 'selection_mismatch' });
    args.canonicalResult.context.client.status = 'archived';
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'source_mismatch' });
    args.canonicalResult.context.client.status = 'active';
    args.canonicalResult.context.client.tenantId = OTHER;
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'source_mismatch' });
  });

  it('rejects nested schema drift before any source result is released', () => {
    const args = fixture();
    delete args.canonicalResult.context.client.createdAt;
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'contract_mismatch' });
    args.canonicalResult.context.client.createdAt = AS_OF;
    (args.canonicalResult.context.client as Record<string, unknown>).unsupported = true;
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'contract_mismatch' });
  });

  it('keeps an unavailable selected section unknown rather than empty evidence', () => {
    const args = fixture('advocacyRecords');
    const coverage = args.canonicalResult.profileSections.advocacyRecords as Record<string, unknown>;
    Object.assign(coverage, { status: 'unavailable', total: null, truncated: null, error: 'section_unavailable' });
    expect(prepareRetainedClientContextV02(reseal(args)).kind).toBe('prepared');
    coverage.total = 0;
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
  });

  it('checks selected-section continuation, exact full row scope, and source references', () => {
    const args = fixture('capabilities', 1);
    const coverage = args.canonicalResult.profileSections.capabilities as Record<string, unknown>;
    const row = fields('ProfileClientCapability');
    Object.assign(row, { id: OTHER, tenantId: TENANT, clientId: CLIENT, name: 'Capability' });
    args.canonicalResult.profile.capabilities = [row];
    args.canonicalResult.profileSources.capabilities = [{ recordId: OTHER, updatedAt: AS_OF }];
    Object.assign(coverage, {
      status: 'partial', total: 2, returned: 1, truncated: true,
      nextCursor: Buffer.from(JSON.stringify({
        v: 1, clientId: CLIENT, section: 'capabilities', afterId: OTHER,
      })).toString('base64url'),
    });
    expect(prepareRetainedClientContextV02(reseal(args)).kind).toBe('prepared');
    args.canonicalResult.profileSources.capabilities[0]!.updatedAt = '2026-10-18T12:34:57.000Z';
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
    args.canonicalResult.profileSources.capabilities[0]!.updatedAt = AS_OF;
    coverage.nextCursor = Buffer.from(JSON.stringify({
      v: 1, clientId: OTHER, section: 'capabilities', afterId: OTHER,
    })).toString('base64url');
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'cursor_mismatch' });
  });

  it('rejects fabricated engagement coverage and noncanonical observations', () => {
    const args = fixture();
    args.canonicalResult.context.summary.openTasks = 1;
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
    args.canonicalResult.context.summary.openTasks = 0;
    args.canonicalResult.context.recentActivity = [{
      type: 'meeting', id: OTHER, title: 'Meeting', date: '2026-10-18T12:34:56Z',
    }] as never[];
    expect(prepareRetainedClientContextV02(reseal(args)))
      .toEqual({ kind: 'refused', reason: 'observation_mismatch' });
  });
});
