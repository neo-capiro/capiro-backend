import { FundingExecutionController } from './funding-execution.controller.js';

describe('FundingExecutionController', () => {
  test('forwards temporal selectors without introducing tenant scope', async () => {
    const read = jest.fn(async (input: unknown) => input);
    const controller = new FundingExecutionController({ read } as never);
    await controller.program('p1', { asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' } as never);
    await controller.pe('0604802A', { asOfFy: 2027 } as never);
    expect(read.mock.calls.map(([input]) => input)).toEqual([
      { programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' },
      { peCode: '0604802A', asOfFy: 2027 },
    ]);
  });
});
