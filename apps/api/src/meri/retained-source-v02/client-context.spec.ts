import { CLIENT_PROFILE_SECTIONS } from '../meri-client-context.helpers.js';
import {
  prepareRetainedClientContextV02,
  RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE,
} from './client-context.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const AS_OF = '2026-10-18T12:34:56.000Z';

function fixture(section: string | null = null, limit = 25) {
  const representation = section ? 'full' : 'summary';
  const profileSections = Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, {
    status: section && section !== name ? 'not_requested' : 'complete',
    total: section && section !== name ? null : 0,
    returned: 0,
    limit,
    truncated: section && section !== name ? null : false,
    nextCursor: null,
    representation,
    source: { tool: 'get_client_context', clientId: CLIENT, section: name },
  }]));
  const profile: Record<string, Record<string, unknown>[]> =
    Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, []]));
  const profileSources: Record<string, Record<string, unknown>[]> =
    Object.fromEntries(CLIENT_PROFILE_SECTIONS.map((name) => [name, []]));
  return {
    request: { clientId: CLIENT, ...(section ? { section } : {}), limit },
    normalizedInput: { clientId: CLIENT, section, afterId: null, limit, representation },
    trusted: {
      tenantId: TENANT, selectedClientId: CLIENT, asOf: AS_OF,
      clientResolution: { selector: CLIENT, clientId: CLIENT },
    },
    canonicalResult: {
      tool: 'get_client_context', generatedAt: AS_OF,
      profileSections,
      coverageNote: RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE,
      profile,
      profileSources,
      context: { client: { id: CLIENT, tenantId: TENANT, status: 'active' } },
    },
  };
}

describe('Core retained client-context 0.2 source preparation', () => {
  it('preserves the canonical six-section result as a candidate requiring full contract validation', () => {
    const args = fixture();
    expect(prepareRetainedClientContextV02(args)).toEqual({
      kind: 'prepared', requiresFullContractValidation: true, result: args.canonicalResult,
    });
    expect(Object.keys(args.canonicalResult.profileSections)).toEqual([...CLIENT_PROFILE_SECTIONS]);
  });

  it('refuses an untransmitted or clock-substituted trusted observation instant', () => {
    const args = fixture();
    args.canonicalResult.generatedAt = '2026-10-18T12:34:57.000Z';
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'observation_mismatch' });
    expect(args.canonicalResult.generatedAt).toBe('2026-10-18T12:34:57.000Z');
    expect(prepareRetainedClientContextV02({ ...args, trusted: { ...args.trusted, asOf: '' } }))
      .toEqual({ kind: 'refused', reason: 'trusted_context_missing' });
  });

  it('refuses client selection, resolution and source client or tenant drift', () => {
    const args = fixture();
    expect(prepareRetainedClientContextV02({ ...args, trusted: {
      ...args.trusted, clientResolution: { selector: CLIENT, clientId: OTHER },
    } })).toEqual({ kind: 'refused', reason: 'trusted_context_missing' });
    expect(prepareRetainedClientContextV02({ ...args, request: { clientId: OTHER } }))
      .toEqual({ kind: 'refused', reason: 'selection_mismatch' });
    expect(prepareRetainedClientContextV02({ ...args, canonicalResult: {
      ...args.canonicalResult, context: { client: { id: OTHER, tenantId: TENANT, status: 'active' } },
    } })).toEqual({ kind: 'refused', reason: 'source_mismatch' });
    expect(prepareRetainedClientContextV02({ ...args, canonicalResult: {
      ...args.canonicalResult, context: { client: { id: CLIENT, tenantId: OTHER, status: 'active' } },
    } })).toEqual({ kind: 'refused', reason: 'source_mismatch' });
  });

  it('refuses archived clients and cross-client section sources', () => {
    const args = fixture('capabilities');
    args.canonicalResult.context.client.status = 'archived';
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'source_mismatch' });
    args.canonicalResult.context.client.status = 'active';
    (args.canonicalResult.profileSections.people as { source: { clientId: string } }).source.clientId = OTHER;
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
  });

  it('preserves an unavailable section as unknown rather than empty evidence', () => {
    const args = fixture('advocacyRecords');
    const coverage = args.canonicalResult.profileSections.advocacyRecords as Record<string, unknown>;
    Object.assign(coverage, { status: 'unavailable', total: null, truncated: null, error: 'section_unavailable' });
    expect(prepareRetainedClientContextV02(args).kind).toBe('prepared');
    coverage.total = 0;
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
  });

  it('requires exact selected-section continuation and ordered source references', () => {
    const args = fixture('capabilities', 1);
    const coverage = args.canonicalResult.profileSections.capabilities as Record<string, unknown>;
    Object.assign(coverage, {
      status: 'partial', total: 2, returned: 1, truncated: true,
      nextCursor: Buffer.from(JSON.stringify({
        v: 1, clientId: CLIENT, section: 'capabilities', afterId: 'cap-1',
      })).toString('base64url'),
    });
    args.canonicalResult.profile.capabilities = [{ id: 'cap-1', name: 'One' }];
    args.canonicalResult.profileSources.capabilities = [{ recordId: 'cap-1' }];
    expect(prepareRetainedClientContextV02(args).kind).toBe('prepared');
    coverage.nextCursor = Buffer.from(JSON.stringify({
      v: 1, clientId: OTHER, section: 'capabilities', afterId: 'cap-1',
    })).toString('base64url');
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'cursor_mismatch' });
    coverage.nextCursor = Buffer.from(JSON.stringify({
      v: 1, clientId: CLIENT, section: 'capabilities', afterId: 'cap-1',
    })).toString('base64url');
    args.canonicalResult.profileSources.capabilities = [{ recordId: 'other-cap' }];
    expect(prepareRetainedClientContextV02(args)).toEqual({ kind: 'refused', reason: 'coverage_mismatch' });
  });
});
