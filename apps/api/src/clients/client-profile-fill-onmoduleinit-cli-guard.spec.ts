import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

/**
 * Regression: neither Fill with Meri sweep service may start its
 * setInterval/queueMicrotask loop in a process that has no HTTP adapter —
 * i.e. a `NestFactory.createApplicationContext(AppModule, ...)` one-shot CLI
 * bootstrap (LegiWatch Phase 9's `run-legiwatch-phase9-job.ts` /
 * `run-legiwatch-phase9-operator.ts`, and any future script that reuses the
 * full AppModule). Those processes run their one job for ~1s and then call
 * `app.close()`, which disconnects PrismaService. A sweep timer started in
 * that context queues a `withSystem`/`withTenant` call that races the
 * disconnect and throws the live-observed
 * "Transaction API error: Transaction not found ... obtained before
 * disconnecting" on a ~1-2 minute cadence in the capiro-dev-api logs.
 *
 * The real long-running server (`apps/api/src/main.ts`,
 * `NestFactory.create(AppModule, ...)`) DOES register an HTTP adapter, so
 * `HttpAdapterHost.httpAdapter` is populated there and the guard must let
 * the sweep start normally.
 */
describe('Fill with Meri sweep services — CLI/one-shot bootstrap guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWorkerFlag = process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED;
  const originalCompletionFlag = process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;

  beforeEach(() => {
    // The guard also short-circuits on NODE_ENV==='test' (jest's default) —
    // override it here so these tests actually exercise the httpAdapterHost
    // branch instead of always hitting the test short-circuit first.
    process.env.NODE_ENV = 'production';
    delete process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED;
    delete process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalWorkerFlag === undefined) delete process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED;
    else process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED = originalWorkerFlag;
    if (originalCompletionFlag === undefined) {
      delete process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
    } else {
      process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED = originalCompletionFlag;
    }
    jest.restoreAllMocks();
  });

  describe('ClientProfileFillWorkflowService', () => {
    function build(httpAdapterHost: unknown) {
      const service = new ClientProfileFillWorkflowService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        httpAdapterHost as any,
      );
      return service;
    }

    it('does NOT start the sweep timer when no HTTP adapter is registered (one-shot CLI bootstrap)', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build({ httpAdapter: undefined });

      service.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('does NOT start the sweep timer when httpAdapterHost itself is undefined', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build(undefined);

      service.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('DOES start the sweep timer when a real HTTP adapter is registered (the long-running server)', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build({ httpAdapter: { getInstance: () => ({}) } });

      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  describe('ClientProfileFillCompletionService', () => {
    function build(httpAdapterHost: unknown) {
      const service = new ClientProfileFillCompletionService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        httpAdapterHost as any,
        {} as any,
      );
      return service;
    }

    it('does NOT start either sweep timer when no HTTP adapter is registered (one-shot CLI bootstrap)', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build({ httpAdapter: undefined });

      service.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('DOES start both sweep timers when a real HTTP adapter is registered (the long-running server)', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build({ httpAdapter: { getInstance: () => ({}) } });

      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    });
  });
});
