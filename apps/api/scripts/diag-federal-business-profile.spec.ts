import { describe, expect, test } from '@jest/globals';
import { parseArgs } from './diag-federal-business-profile.js';

describe('CLI parsing', () => {
  test('requires both --tenant and --client', () => {
    expect(parseArgs([])).toEqual({ error: '--tenant=<uuid> is required' });
    expect(parseArgs(['--tenant=t1'])).toEqual({ error: '--client=<uuid> is required' });
  });

  test('a well-formed invocation parses cleanly', () => {
    expect(parseArgs(['--tenant=t1', '--client=c1'])).toEqual({ tenantId: 't1', clientId: 'c1' });
  });
});
