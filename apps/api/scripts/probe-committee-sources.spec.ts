import { buildProbeAdapters } from './probe-committee-sources.js';

describe('committee source probe adapter registry', () => {
  it('registers the Senate committee calendar adapter for enabled sources', () => {
    const adapters = buildProbeAdapters(119);

    expect([...adapters.keys()]).toEqual([
      'congress-gov',
      'house-repository',
      'senate-schedule',
      'senate-committee-calendar',
      'committee-site',
      'govinfo-chrg',
    ]);
    expect(adapters.get('senate-committee-calendar')?.healthCheck).toEqual(expect.any(Function));
  });

  it('keeps govinfo-chrg visible to health checks when its API key is missing', () => {
    const previous = process.env.GOVINFO_API_KEY;
    delete process.env.GOVINFO_API_KEY;
    expect(buildProbeAdapters(119).get('govinfo-chrg')?.healthCheck).toEqual(expect.any(Function));

    process.env.GOVINFO_API_KEY = 'test-key';
    expect(buildProbeAdapters(119).get('govinfo-chrg')?.healthCheck).toEqual(expect.any(Function));

    if (previous === undefined) delete process.env.GOVINFO_API_KEY;
    else process.env.GOVINFO_API_KEY = previous;
  });
});
