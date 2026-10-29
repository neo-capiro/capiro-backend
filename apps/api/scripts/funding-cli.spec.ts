import { describe, expect, jest, test } from '@jest/globals';
import { main as sync } from './sync-tango-funding.js';
import { main as embed } from './embed-funding-catalog.js';
import { main as archive } from './sync-tango-opportunity-attachments.js';

describe('funding CLI safe startup', () => {
  test.each([sync, embed, archive])('help returns without configuration or database allocation', async main => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try { await main(['--help']); expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:')); }
    finally { log.mockRestore(); }
  });
  test.each([sync, embed, archive])('unknown arguments refuse before configuration or database access', async main => {
    await expect(main(['--unexpected'])).rejects.toThrow('Usage:');
  });
  test('invalid limits refuse before credentials and database access', async () => {
    await expect(sync(['--max-requests=NaN'])).rejects.toThrow('Invalid --max-requests');
    await expect(sync(['--extract-limit=0'])).rejects.toThrow('Invalid --extract-limit');
    await expect(embed(['--limit=0'])).rejects.toThrow('Invalid embedding limits');
  });
});
