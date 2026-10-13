import { contractorRow, harness, installHooks } from '../../test/fixtures/intelligence-identity.js';

installHooks();

it.each<{ label: string; input: unknown; expected: number | null }>([
  { label: 'null', input: null, expected: null },
  { label: 'undefined', input: undefined, expected: null },
  { label: 'numeric string', input: '12.5', expected: 12.5 },
  { label: 'blank string', input: ' ', expected: 0 },
  { label: 'boolean', input: true, expected: 1 },
  { label: 'negative zero', input: -0, expected: -0 },
  { label: 'bigint', input: 9n, expected: 9 },
  { label: 'infinity', input: Infinity, expected: null },
  { label: 'invalid string', input: 'not-money', expected: null },
  { label: 'valueOf decimal', input: { valueOf: () => '12.5' }, expected: 12.5 },
  { label: 'toString decimal', input: { toString: () => '-7.25' }, expected: -7.25 },
  { label: 'toNumber-only decimal', input: { toNumber: () => 99 }, expected: null },
])(
  'identity contractor money uses canonical Number coercion for $label in both lookups',
  async (example) => {
    const row = contractorRow({ total_contracts: example.input, no_bid_total: example.input });
    const h = harness({ rows: { contractorName: [row], fuzzyContractor: [row] } });
    const direct = await h.subject.fetchContractorById('Exact Name');
    const fuzzy = await h.subject.fuzzyMatchContractor('Fuzzy Name');
    expect(direct!.totalContracts).toBe(example.expected);
    expect(direct!.noBidTotal).toBe(example.expected);
    expect(fuzzy!.totalContracts).toBe(example.expected);
    expect(fuzzy!.noBidTotal).toBe(example.expected);
    expect(h.calls.map((call) => call.operation)).toEqual(['contractorName', 'fuzzyContractor']);
  },
);

it('identity contractor Number coercion invokes primitive conversion rather than duck toNumber', async () => {
  const primitive = jest.fn(() => '27');
  const duck = jest.fn(() => 99);
  const money = { [Symbol.toPrimitive]: primitive, toNumber: duck };
  const h = harness({
    rows: { contractorName: [contractorRow({ total_contracts: money, no_bid_total: null })] },
  });
  expect((await h.subject.fetchContractorById('Exact Name'))!.totalContracts).toBe(27);
  expect(primitive).toHaveBeenCalledWith('number');
  expect(duck).not.toHaveBeenCalled();
});

it.each(['direct', 'fuzzy'])(
  'identity contractor %s lookup propagates coercion exceptions without a partial projection',
  async (method) => {
    const failure = new Error('Decimal primitive failed');
    const money = {
      valueOf: () => {
        throw failure;
      },
    };
    const row = contractorRow({ total_contracts: money });
    const h = harness({ rows: { contractorName: [row], fuzzyContractor: [row] } });
    const work =
      method === 'direct'
        ? h.subject.fetchContractorById('Exact Name')
        : h.subject.fuzzyMatchContractor('Fuzzy Name');
    await expect(work).rejects.toBe(failure);
    expect(h.calls).toHaveLength(1);
  },
);

it('identity contractor money coercion retains symbol TypeError and evaluates total before no-bid', async () => {
  const noBid = jest.fn(() => 20);
  const h = harness({
    rows: {
      contractorName: [
        contractorRow({ total_contracts: Symbol('money'), no_bid_total: { valueOf: noBid } }),
      ],
    },
  });
  await expect(h.subject.fetchContractorById('Exact Name')).rejects.toThrow(TypeError);
  expect(noBid).not.toHaveBeenCalled();
});
