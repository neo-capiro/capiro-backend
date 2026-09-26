import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeMeriPhase4AuthorizationVersionV2,
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
} from './meri-hermes-phase4-authorization.contract.js';

const source = readFileSync(join(__dirname, 'meri-hermes-phase4-authorization.contract.ts'), 'utf8');
const valid = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user', policyVersion: MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  grantVersion: 'g2:7',
  authorizedClientIds: ['33333333-3333-4333-8333-333333333333'],
  authorizedMailboxConnectionIds: ['44444444-4444-4444-8444-444444444444'],
};

describe('Phase 4 authorization UUID framing', () => {
  it('pins the 8-4-4-4-12 expression in source', () => {
    expect(source).toContain(
      'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;',
    );
  });

  it('accepts canonical UUIDs and rejects missing or extra groups in each identity slot', () => {
    expect(computeMeriPhase4AuthorizationVersionV2(valid)).toMatch(/^m4a2:[0-9a-f]{64}$/);
    const malformed = ['11111111-1111-4111-111111111111',
      '11111111-1111-4111-8111-111111111111-0000',
      '11111111-1111-4111-8111-11111111111g'];
    for (const value of malformed) {
      for (const field of ['tenantId', 'actorId'] as const) {
        expect(() => computeMeriPhase4AuthorizationVersionV2({
          ...valid, [field]: value,
        })).toThrow('invalid current authorization material');
      }
      expect(() => computeMeriPhase4AuthorizationVersionV2({
        ...valid, authorizedClientIds: [value],
      })).toThrow('invalid current authorization set');
      expect(() => computeMeriPhase4AuthorizationVersionV2({
        ...valid, authorizedMailboxConnectionIds: [value],
      })).toThrow('invalid current authorization set');
    }
  });
});
