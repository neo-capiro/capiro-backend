import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { resolveEngagementRuntimeEnvironment } from '../engagement/runtime/engagement-runtime-env.js';

describe('notetaker worker uses the explicit named production owner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  const env = {
    CAPIRO_SERVICE_NAME: 'api', ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'api', ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_and_notetaker',
    ENGAGEMENT_CALLBACKS_ENABLED: 'true', ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'true',
  };
  it('starts one named timer despite generic workers being disabled and runs the guarded sweep', async () => {
    const policy = new EngagementRuntimePolicyService(resolveEngagementRuntimeEnvironment(env));
    const sweep = jest.fn().mockResolvedValue(undefined);
    const worker = new NotetakerReconcileWorkerService({ runReconcileSweep: sweep } as never, policy);
    expect(policy.backgroundWorkersEnabled()).toBe(false);
    worker.onModuleInit(); worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('keeps integrations_only unable to start Recall work', async () => {
    const policy = new EngagementRuntimePolicyService(resolveEngagementRuntimeEnvironment({
      ...env, ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_only', ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    }));
    const sweep = jest.fn();
    const worker = new NotetakerReconcileWorkerService({ runReconcileSweep: sweep } as never, policy);
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(sweep).not.toHaveBeenCalled();
  });
});
