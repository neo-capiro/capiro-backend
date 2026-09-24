import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  getDistrictNexusAlerts,
  getDistrictAlertPreference,
  putDistrictAlertPreference,
} from './r5-api.js';

describe('District Nexus alerts API routes', () => {
  it('uses the same /api prefix as the brief for list and preference reads/writes', async () => {
    const adapter = vi.fn(async (config) => ({
      data: config.method === 'get' && config.url?.includes('preference')
        ? { enabled: true } : [],
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    const api = axios.create({ adapter });
    await getDistrictNexusAlerts(api, 'client-1', 'TX', '08');
    await getDistrictAlertPreference(api, 'client-1');
    await putDistrictAlertPreference(api, 'client-1', true);

    expect(adapter).toHaveBeenCalledTimes(3);
    expect(adapter.mock.calls.map(([request]) => request.url)).toEqual([
      '/api/intelligence/district-nexus/r5/alerts?clientId=client-1&state=TX&district=08',
      '/api/intelligence/district-nexus/r5/alerts/preference',
      '/api/intelligence/district-nexus/r5/alerts/preference',
    ]);
    expect(adapter.mock.calls.map(([request]) => request.method)).toEqual(['get', 'get', 'put']);
  });
});
