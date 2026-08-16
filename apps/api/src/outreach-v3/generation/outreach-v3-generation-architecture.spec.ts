import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOutreachV3GenerationEnabled } from './outreach-v3-generation.guard.js';
import { parseOutreachV3FullGenerationEnabled } from './outreach-v3-full-generation.guard.js';

function apiRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith('apps/api') ? cwd : resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

describe('Outreach V3 governed generation architecture', () => {
  it('keeps generation and full generation default-off and strict', () => {
    expect(parseOutreachV3GenerationEnabled(undefined)).toBe(false);
    expect(parseOutreachV3GenerationEnabled('true')).toBe(true);
    expect(parseOutreachV3GenerationEnabled('false')).toBe(false);
    expect(() => parseOutreachV3GenerationEnabled('maybe')).toThrow(
      'Invalid OUTREACH_V3_GENERATION_ENABLED value',
    );
    expect(parseOutreachV3FullGenerationEnabled(undefined)).toBe(false);
    expect(parseOutreachV3FullGenerationEnabled('1')).toBe(true);
    expect(parseOutreachV3FullGenerationEnabled('0')).toBe(false);
    expect(() => parseOutreachV3FullGenerationEnabled('maybe')).toThrow(
      'Invalid OUTREACH_V3_FULL_GENERATION_ENABLED value',
    );
  });

  it('composes V3 HTTP generation only into engagement-api', () => {
    const engagementApp = readApi('src/engagement-api.app.module.ts');
    const mainApp = readApi('src/app.module.ts');
    expect(engagementApp).toContain(
      "import { OutreachV3GenerationModule } from './outreach-v3/generation/outreach-v3-generation.module.js';",
    );
    expect(engagementApp).toContain('OutreachV3GenerationModule');
    expect(mainApp).not.toContain('OutreachV3GenerationModule');
    expect(mainApp).not.toContain('outreach-v3/generation/outreach-v3-generation.module');
  });

  it('exposes full generation only as a durable async job action', () => {
    const controller = readApi('src/outreach-v3/generation/outreach-v3-generation.controller.ts');
    const full = readApi('src/outreach-v3/generation/outreach-v3-full-generation.service.ts');
    expect(controller).toContain("@Get('plan')");
    expect(controller).toContain("@Post('samples')");
    expect(controller).toContain("@Post('approach-approval')");
    expect(controller).toContain("@Post('full')");
    expect(controller).toContain("@Get('jobs/:jobId')");
    expect(controller).toContain("@Post('jobs/:jobId/cancel')");
    expect(controller).toContain("@Post('jobs/:jobId/items/:itemId/retry')");
    expect(controller).toContain('OutreachV3FullGenerationGuard');
    expect(full).toContain('kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND');
    expect(full).toContain('payload: { generationKey: item.generationKey }');
    expect(full).not.toContain('authHeader');
    expect(full).not.toContain('Authorization');
    expect(full).not.toContain('sendMail(');
    expect(full).not.toContain('OutreachSendIntentService');
  });

  it('keeps the planner incapable of model, draft, approval, preflight or send actions', () => {
    const service = readApi('src/outreach-v3/generation/outreach-v3-generation.service.ts');
    const plan = readApi('src/outreach-v3/generation/outreach-v3-generation-plan.ts');
    const combined = `${service}\n${plan}`;
    for (const forbidden of [
      'GenerationGatewayService',
      'OutreachJobService',
      'OutreachDraftService',
      'OutreachSendIntentService',
      'sendMail(',
      'mailSender',
      'OpenAI',
      'Anthropic',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it('keeps sample generation bounded and unable to auto-approve/full-generate/send', () => {
    const samples = readApi('src/outreach-v3/generation/outreach-v3-sample-generation.service.ts');
    expect(samples).toContain('plan.representativeSampleKeys.length > 3');
    expect(samples).toContain('fullGenerationStarted: false');
    expect(samples).toContain('approachApprovalRequired: true');
    expect(samples).toContain('sendable: false');
    expect(samples).toContain('includeRelevantEmail: false');
    for (const forbidden of [
      'OutreachSendIntentService',
      'sendMail(',
      'createOutreachV3ApproachApprovalSnapshot(',
      'OutreachV3FullGenerationService',
    ]) {
      expect(samples).not.toContain(forbidden);
    }
  });

  it('keeps approach approval exact and invalidates it after sample version changes', () => {
    const approval = readApi('src/outreach-v3/generation/outreach-v3-approach-approval.service.ts');
    const decision = readApi('src/outreach-v3/services/outreach-user-decision-event.service.ts');
    const reasoning = readApi('src/outreach-v3/reasoning/outreach-reasoning.service.ts');
    expect(approval).toContain("eventType: 'approach_approved'");
    expect(approval).toContain('loadVersionContextPacketId');
    expect(approval).toContain('current.id === sample.versionId');
    expect(approval).toContain('current.contentHash === sample.contentHash');
    expect(approval).toContain('payloadHash: approval.approvalHash');
    expect(decision).toContain("'approach_approved'");
    expect(decision).toContain('session.currentStateVersion !== input.expectedStateVersion');
    expect(reasoning).not.toContain('OutreachV3ApproachApprovalService');
    expect(reasoning).not.toContain('OutreachV3FullGenerationService');
  });

  it('registers the V3 worker with the current owner without importing V3 controllers into main', () => {
    const workers = readApi('src/engagement-workers/engagement-workers.module.ts');
    const worker = readApi('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    expect(workers).toContain('OutreachV3FullGenerationWorkerService');
    expect(workers).toContain('OutreachV3GenerationPreparationService');
    expect(workers).not.toContain('OutreachV3GenerationModule');
    expect(worker).toContain('runtime.backgroundWorkersEnabled()');
    expect(worker).toContain("assertBackgroundOwner('outreach-v3-full-generation-worker')");
    expect(worker).toContain('FOR UPDATE OF i SKIP LOCKED');
    expect(worker).toContain('includeRelevantEmail: false');
    expect(worker).toContain('existingVersionForPlan');
    expect(worker).not.toContain('authHeader');
    expect(worker).not.toContain('sendMail(');
  });

  it('freezes the route and authority contract', () => {
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-generation-route-manifest.v1.json'),
    ) as {
      runtime: string;
      requiresStateFlag: string;
      featureFlag: string;
      fullGenerationFlag: string;
      disabledBehavior: number;
      routes: Array<Record<string, unknown>>;
      authority: Record<string, boolean>;
    };
    expect(manifest.runtime).toBe('engagement-api');
    expect(manifest.requiresStateFlag).toBe('OUTREACH_V3_STATE_ENABLED');
    expect(manifest.featureFlag).toBe('OUTREACH_V3_GENERATION_ENABLED');
    expect(manifest.fullGenerationFlag).toBe('OUTREACH_V3_FULL_GENERATION_ENABLED');
    expect(manifest.disabledBehavior).toBe(404);
    expect(manifest.routes).toHaveLength(7);
    expect(manifest.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', handler: 'generateSamples', maxSlots: 3 }),
        expect.objectContaining({
          method: 'POST',
          handler: 'approveApproach',
          humanDecisionOnly: true,
        }),
        expect.objectContaining({
          method: 'POST',
          handler: 'startFullGeneration',
          asyncOnly: true,
        }),
        expect.objectContaining({
          method: 'POST',
          handler: 'retryFullGenerationItem',
          failedItemsOnly: true,
        }),
      ]),
    );
    expect(manifest.authority).toEqual({
      modelCall: true,
      representativeSamples: true,
      draftWrite: true,
      approachApproval: true,
      fullGeneration: true,
      fullGenerationAsyncOnly: true,
      preflight: false,
      sendIntent: false,
      mailProviderAction: false,
      memoryCommit: false,
    });
  });
});
