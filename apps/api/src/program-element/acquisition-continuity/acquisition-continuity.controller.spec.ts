import { AcquisitionContinuityController } from './acquisition-continuity.controller.js';

describe('AcquisitionContinuityController', () => {
  test('leaves omitted knownAt unset so a cursor can supply its pinned snapshot', async () => {
    const read = jest.fn(async (input: unknown) => input);
    const controller = new AcquisitionContinuityController({ read } as never);
    await controller.program('p1', { asOfFy: 2027 } as never);
    await controller.pe('0604802A', { asOfFy: 2027 } as never);
    await controller.procurement('line-1', { asOfFy: 2027 } as never);
    expect(read.mock.calls.map(([input]) => input)).toEqual([
      { programId: 'p1', asOfFy: 2027 },
      { peCode: '0604802A', asOfFy: 2027 },
      { procurementLineId: 'line-1', asOfFy: 2027 },
    ]);
  });
});
