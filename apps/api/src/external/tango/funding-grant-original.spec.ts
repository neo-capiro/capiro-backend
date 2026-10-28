import { readOriginalGrant, originalGrantFields } from './funding-grant-original.js';

describe('exact original grant document fallback', () => {
  test('uses explicit status and preserves omitted enrichment', () => {
    expect(originalGrantFields({ ost: 'CLOSED', synopsis: { costSharing: false, awardFloor: '0' } }))
      .toEqual({ status: 'closed', costSharing: false, awardFloor: 0 });
    expect(originalGrantFields({ synopsis: { responseDate: '2020-01-01' } })).not.toHaveProperty('status');
    expect(originalGrantFields({ ost: 'UNDEFINED', opportunityTitle: 'Known government record' }))
      .toEqual({ title: 'Known government record' });
  });
  test('validates the response identity, including error envelopes behind HTTP 200', async () => {
    const transport = jest.fn(async () => new Response(JSON.stringify({ errorcode: 0, data: { id: 123, ost: 'CLOSED' } }))) as unknown as typeof fetch;
    expect(await readOriginalGrant('123', transport)).toEqual({ id: 123, ost: 'CLOSED' });
    await expect(readOriginalGrant('999', transport)).rejects.toThrow('identity mismatch');
    await expect(readOriginalGrant('123', async () => new Response(JSON.stringify({ errorcode: 1 })))).rejects.toThrow('application error');
  });
  test('404 is unavailable evidence and transient failures remain retryable', async () => {
    expect(await readOriginalGrant('123', async () => new Response(null, { status: 404 }))).toBeNull();
    expect(await readOriginalGrant('123', async () => new Response(JSON.stringify({ errorcode: 0, data: { errorMessages: ['There is no record found for your search.'] } })))).toBeNull();
    await expect(readOriginalGrant('123', async () => new Response(JSON.stringify({ errorcode: 0, data: {} })))).rejects.toThrow('identity mismatch');
    await expect(readOriginalGrant('123', async () => new Response(null, { status: 503 }))).rejects.toThrow('503');
  });
});
