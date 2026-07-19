import {
  buildConferencePredictionFromHistory,
  ConferenceProbabilityService,
} from './conference-probability.service.js';

interface BacktestRow {
  request: number;
  hascMark: number;
  sascMark: number;
  conference: number;
}

function toBinaryOutcome(row: BacktestRow): number {
  if (row.sascMark === row.hascMark) return 0;
  if (row.sascMark > row.hascMark) {
    return row.conference >= row.hascMark + 0.5 * (row.sascMark - row.hascMark) ? 1 : 0;
  }
  return row.conference <= row.hascMark + 0.5 * (row.sascMark - row.hascMark) ? 1 : 0;
}

function toProbability(predictedConference: number, hascMark: number, sascMark: number): number {
  if (sascMark === hascMark) return 0.5;
  const midpoint = hascMark + 0.5 * (sascMark - hascMark);
  if (sascMark > hascMark) {
    return predictedConference >= midpoint ? 1 : 0;
  }
  return predictedConference <= midpoint ? 1 : 0;
}

function brierScore(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length);
  if (n === 0) return 1;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const a = actual[i] ?? 0;
    const p = predicted[i] ?? 0;
    total += (p - a) ** 2;
  }
  return total / n;
}

describe('ConferenceProbabilityService model behavior', () => {
  test('backtest FY24+FY25 holds loose Brier <= 0.20 on fixture-like rows', () => {
    const rows: BacktestRow[] = [
      { request: 220.1, hascMark: 235.2, sascMark: 214.0, conference: 224.0 },
      { request: 233.4, hascMark: 228.0, sascMark: 241.0, conference: 232.0 },
      { request: 245.8, hascMark: 260.0, sascMark: 252.0, conference: 253.0 },
      { request: 262.0, hascMark: 250.0, sascMark: 244.0, conference: 245.0 },
      { request: 130.0, hascMark: 136.0, sascMark: 132.0, conference: 133.0 },
      { request: 138.0, hascMark: 134.0, sascMark: 141.0, conference: 137.0 },
      { request: 145.0, hascMark: 149.0, sascMark: 146.0, conference: 146.5 },
      { request: 151.0, hascMark: 150.0, sascMark: 154.0, conference: 151.5 },
    ];

    const predicted: number[] = [];
    const actual: number[] = [];

    for (let i = 1; i < rows.length; i += 1) {
      const training = rows.slice(0, i);
      const target = rows[i];
      if (!target) continue;

      const prediction = buildConferencePredictionFromHistory(target, training);
      if (!prediction) continue;

      predicted.push(toProbability(prediction.predicted, target.hascMark, target.sascMark));
      actual.push(toBinaryOutcome(target));
    }

    expect(predicted.length).toBeGreaterThan(0);
    expect(brierScore(actual, predicted)).toBeLessThanOrEqual(0.2);
  });

  test('no history returns null', () => {
    const prediction = buildConferencePredictionFromHistory(
      {
        request: 200,
        hascMark: 190,
        sascMark: 210,
      },
      [],
    );

    expect(prediction).toBeNull();
  });

  test('gap=0 returns hasc=sasc prediction with low confidence', () => {
    const prediction = buildConferencePredictionFromHistory(
      {
        request: 200,
        hascMark: 205,
        sascMark: 205,
      },
      [
        {
          request: 190,
          hascMark: 188,
          sascMark: 196,
          conference: 192,
        },
      ],
    );

    expect(prediction).not.toBeNull();
    expect(prediction?.predicted).toBe(205);
    expect(prediction?.ciLow).toBe(205);
    expect(prediction?.ciHigh).toBe(205);
    expect(prediction?.confidence).toBeCloseTo(0.1, 6);
  });
});

describe('ConferenceProbabilityService.predict persist flag (GAI-25)', () => {
  // target: gap != 0, conference NULL (so predict proceeds to the model path),
  // cache miss, plus history that yields a non-null prediction.
  const target = {
    peCode: '0601000N',
    fy: 2027,
    service: 'navy',
    request: 151,
    hascMark: 150,
    sascMark: 154,
    conference: null,
  };
  const historyRows = [
    {
      peCode: '0601000N',
      fy: 2020,
      service: 'navy',
      request: 220.1,
      hascMark: 235.2,
      sascMark: 214.0,
      conference: 224.0,
    },
    {
      peCode: '0601000N',
      fy: 2021,
      service: 'navy',
      request: 233.4,
      hascMark: 228.0,
      sascMark: 241.0,
      conference: 232.0,
    },
    {
      peCode: '0601000N',
      fy: 2022,
      service: 'navy',
      request: 245.8,
      hascMark: 260.0,
      sascMark: 252.0,
      conference: 253.0,
    },
    {
      peCode: '0601000N',
      fy: 2023,
      service: 'navy',
      request: 262.0,
      hascMark: 250.0,
      sascMark: 244.0,
      conference: 245.0,
    },
    {
      peCode: '0601000N',
      fy: 2024,
      service: 'navy',
      request: 145.0,
      hascMark: 149.0,
      sascMark: 146.0,
      conference: 146.5,
    },
    {
      peCode: '0601000N',
      fy: 2025,
      service: 'navy',
      request: 151.0,
      hascMark: 150.0,
      sascMark: 154.0,
      conference: 151.5,
    },
  ];

  function makeService() {
    // $queryRaw is called 3x in order: targetRows, cache lookup (miss), history.
    const queue: unknown[] = [[target], [], historyRows];
    const executeRaw = jest.fn(async () => 1);
    const prisma = {
      $queryRaw: jest.fn(async () => queue.shift() ?? []),
      $executeRaw: executeRaw,
    };
    return { service: new ConferenceProbabilityService(prisma as never), executeRaw };
  }

  test('persist=false (read path) computes + returns a prediction but never upserts', async () => {
    const { service, executeRaw } = makeService();
    const prediction = await service.predict(target.peCode, target.fy, false);
    expect(prediction).not.toBeNull();
    expect(typeof prediction?.predicted).toBe('number');
    expect(executeRaw).not.toHaveBeenCalled();
  });

  test('persist defaults to true (batch path) and upserts the prediction', async () => {
    const { service, executeRaw } = makeService();
    const prediction = await service.predict(target.peCode, target.fy);
    expect(prediction).not.toBeNull();
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
