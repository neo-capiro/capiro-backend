import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeriToolsService } from '../../meri/meri-tools.service.js';
import { buyerWireFixture, buyerWireInput } from './buyer-workspace.wire.fixture.js';

test('native buyer serialization matches the receiving vectors without dropping source semantics', async () => {
  const vectors = [];
  for (const unsupported of [false, true]) {
    const service = Object.assign(Object.create(MeriToolsService.prototype), { buyerWorkspace: buyerWireFixture(unsupported) }) as MeriToolsService;
    const response = JSON.parse(JSON.stringify(await service.execute({} as never, 'get_pe_buyer_workspace', buyerWireInput)));
    expect(response.knownAt).toBe('2026-09-24T00:00:00.000Z');
    expect(response.acquisition.state).toBe(unsupported ? 'unsupported' : 'complete');
    if (!unsupported) {
      expect(response.acquisition.data.accepted[0].authoritativeAmountUsd).toBe('20.005');
      expect(response.acquisition.data.candidates[0].authoritativeAmountUsd).toBeNull();
      expect(response.fundingExecution.data.enacted.totals.transactionDeltaUsd).toBe('-12.50');
      expect(response.federalEvidence.data.lifecycle.items[0].afterEvidence.availability).toBe('available');
      expect(response.federalEvidence.data.lifecycle.items[0].beforeEvidence.availability).toBe('unavailable');
    }
    vectors.push({ name: unsupported ? 'unsupported-sources' : 'source-backed', request: buyerWireInput, response });
  }
  const result = { schema: 'meri-buyer-workspace-conformance/1', synthetic: true, vectors };
  const path = join(__dirname, 'buyer-workspace.wire.json');
  if (process.env.UPDATE_BUYER_WIRE_FIXTURE === '1') writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  expect(result).toEqual(JSON.parse(readFileSync(path, 'utf8')));
});
