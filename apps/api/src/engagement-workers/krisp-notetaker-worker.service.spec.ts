import { KrispNotetakerWorkerService } from './krisp-notetaker-worker.service.js';
describe('Krisp worker ownership', () => {
  afterEach(() => jest.useRealTimers());
  test('shadow process starts no timers and never calls Krisp', async () => {
    jest.useFakeTimers();
    const krisp = { sweep: jest.fn() };
    const worker = new KrispNotetakerWorkerService(
      krisp as never,
      { backgroundWorkersEnabled: () => false } as never,
    );
    worker.onModuleInit();
    await worker.tick();
    expect(jest.getTimerCount()).toBe(0);
    expect(krisp.sweep).not.toHaveBeenCalled();
  });
  test('owner starts one timer, avoids overlapping sweeps, and cleans up', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const krisp = {
      sweep: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const worker = new KrispNotetakerWorkerService(
      krisp as never,
      { backgroundWorkersEnabled: () => true } as never,
    );
    worker.onModuleInit();
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    const tick = worker.tick();
    await worker.tick();
    expect(krisp.sweep).toHaveBeenCalledTimes(1);
    finish();
    await tick;
    worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
