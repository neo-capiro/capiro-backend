import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';
import { outreachAudienceWhere } from './outreach-audience.js';
import { campaignListSchema, outreachRecordListSchema } from './outreach-campaign.contract.js';
import { decodeCampaignCursor, encodeCampaignCursor } from './outreach-campaign-summary.js';

// Offline predicate interpreter with SQL's unknown value for a missing JSON path. This checks
// the generated Prisma condition, not a second production classifier or a database execution.
type Truth = boolean | null;
const every = (xs: Truth[]): Truth => xs.includes(false) ? false : xs.includes(null) ? null : true;
const some = (xs: Truth[]): Truth => xs.includes(true) ? true : xs.includes(null) ? null : false;
function evaluate(condition: any, metadata: unknown): Truth {
  if (condition.AND) return every(condition.AND.map((part: unknown) => evaluate(part, metadata)));
  if (condition.OR) return some(condition.OR.map((part: unknown) => evaluate(part, metadata)));
  if (condition.NOT) { const value = evaluate(condition.NOT, metadata); return value === null ? null : !value; }
  const { path, equals } = condition.metadata;
  const value = path.reduce((current: any, key: string) =>
    current && typeof current === 'object' && !Array.isArray(current) ? current[key] : undefined, metadata);
  if (equals === Prisma.AnyNull) return value === undefined || value === null;
  return value === undefined ? null : value === equals;
}

describe('canonical audience population predicate', () => {
  it.each([
    ['missing metadata', undefined, 'on-behalf'],
    ['SQL/JSON null', null, 'on-behalf'],
    ['empty legacy follow_up or prep', {}, 'on-behalf'],
    ['invalid legacy value', { direction: 'client' }, 'on-behalf'],
    ['legacy Client', { direction: 'to-clients' }, 'to-clients'],
    ['legacy External', { direction: 'on-behalf' }, 'on-behalf'],
    ['null legacy', { direction: null }, 'on-behalf'],
    ['array metadata', [], 'on-behalf'],
    ['malformed workflow', { workflow: 'old', direction: 'to-clients' }, 'to-clients'],
    ['invalid workflow direction', { workflow: { state: { direction: false } }, direction: 'to-clients' }, 'to-clients'],
    ['workflow Client overrides stale External', { workflow: { state: { direction: 'to-clients' } }, direction: 'on-behalf' }, 'to-clients'],
    ['workflow External overrides stale Client', { workflow: { state: { direction: 'on-behalf' } }, direction: 'to-clients' }, 'on-behalf'],
    ['workflow missing legacy', { workflow: { state: { direction: 'to-clients' } } }, 'to-clients'],
    ['invalid and missing', { workflow: { state: { direction: [] } } }, 'on-behalf'],
  ])('%s is exclusively %s', (_name, metadata, expected) => {
    for (const direction of ['on-behalf', 'to-clients'] as const) {
      expect(evaluate(outreachAudienceWhere(direction), metadata) === true).toBe(direction === expected);
    }
  });

  it.each([campaignListSchema, outreachRecordListSchema])('validates a selector without widening identity or list fields', (schema) => {
    expect(schema.parse({ direction: 'to-clients', limit: '1' }).direction).toBe('to-clients');
    expect(schema.parse({}).direction).toBeUndefined();
    for (const direction of ['all', 'client', 'external', '', ['on-behalf'], null, 1]) {
      expect(schema.safeParse({ direction }).success).toBe(false);
    }
    expect(schema.safeParse({ direction: 'on-behalf', tenantId: 'spoof' }).success).toBe(false);
    expect(schema.safeParse({ direction: 'on-behalf', userId: 'spoof' }).success).toBe(false);
    expect(schema.safeParse({ direction: 'on-behalf', from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }).success).toBe(false);
  });

  it('does not silently ignore an audience selector on a recovery lookup', () => {
    expect(campaignListSchema.safeParse({ requestKey: '11111111-1111-4111-8111-111111111111', direction: 'to-clients' }).success).toBe(false);
  });

  it('preserves old All cursors and binds filtered cursors to their exact audience', () => {
    const anchor = { id: '11111111-1111-4111-8111-111111111111' };
    const old = encodeCampaignCursor(anchor)!;
    expect(decodeCampaignCursor(old)).toEqual(anchor);
    expect(JSON.parse(Buffer.from(old, 'base64url').toString())).toEqual(anchor);
    for (const direction of ['on-behalf', 'to-clients'] as const) {
      const cursor = encodeCampaignCursor(anchor, direction)!;
      expect(decodeCampaignCursor(cursor, direction)).toEqual(anchor);
      expect(() => decodeCampaignCursor(cursor)).toThrow('Invalid outreach cursor');
      expect(() => decodeCampaignCursor(old, direction)).toThrow('Invalid outreach cursor');
      expect(() => decodeCampaignCursor(cursor, direction === 'on-behalf' ? 'to-clients' : 'on-behalf')).toThrow('Invalid outreach cursor');
    }
    expect(encodeCampaignCursor(null, 'to-clients')).toBeNull();
    expect(() => decodeCampaignCursor('bad!', 'to-clients')).toThrow('Invalid outreach cursor');
  });
});
