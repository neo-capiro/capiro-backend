import { fetchText } from './source-http.js';

it('retains publisher Retry-After evidence on HTTP429 without retrying', async () => {
  const read = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', {
      status: 429,
      headers: { 'Retry-After': '3600' },
    }),
  );
  try {
    const result = await fetchText('https://www.flsenate.gov/Committees/Show/RI');
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      retryAfter: '3600',
      error: 'HTTP 429; Retry-After: 3600',
    });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
  }
});
