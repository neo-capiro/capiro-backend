import { describe, expect, it, vi } from 'vitest';
import {
  getDefenseOffice,
  listDefenseOffices,
  listDefenseRelationships,
} from './defense-research-api.js';

describe('defense research API adapter', () => {
  it('preserves supported office filters without sending empty values', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    await listDefenseOffices({ get } as never, {
      q: 'PEO C3T',
      component: 'Army',
      capability: '',
      page: 2,
    });
    expect(get).toHaveBeenCalledWith('/api/defense-budget/offices', {
      params: { q: 'PEO C3T', component: 'Army', page: 2 },
    });
  });

  it('encodes office ids and keeps speculative relationship enrichment opt-in', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    await getDefenseOffice({ get } as never, 'office/a');
    await listDefenseRelationships({ get } as never, {
      from: 'office/a',
      includeSpeculative: false,
    });
    expect(get).toHaveBeenNthCalledWith(1, '/api/defense-budget/offices/office%2Fa');
    expect(get).toHaveBeenNthCalledWith(2, '/api/defense-budget/relationships', {
      params: { from: 'office/a', includeSpeculative: false },
    });
  });
});
