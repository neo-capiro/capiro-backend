import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseOutreachV3FullGenerationWorkerEnabled } from './outreach-v3-full-generation-worker.service.js';

function apiRoot(): string {
  const cwd = process.cwd();
  // process.cwd() uses the platform separator, so a bare endsWith('apps/api')
  // never matches on Windows and the path silently doubles to apps/api/apps/api.
  return cwd.split(sep).join('/').endsWith('apps/api') ? cwd : resolve(cwd, 'apps/api');
}

const read = (path: string) => readFileSync(resolve(apiRoot(), path), 'utf8');

describe('Outreach V3 full-generation worker boundary', () => {
  it('is default-off and rejects ambiguous flag values', () => {
    expect(parseOutreachV3FullGenerationWorkerEnabled(undefined)).toBe(false);
    expect(parseOutreachV3FullGenerationWorkerEnabled('')).toBe(false);
    expect(parseOutreachV3FullGenerationWorkerEnabled('true')).toBe(true);
    expect(parseOutreachV3FullGenerationWorkerEnabled('1')).toBe(true);
    expect(parseOutreachV3FullGenerationWorkerEnabled('false')).toBe(false);
    expect(() => parseOutreachV3FullGenerationWorkerEnabled('sometimes')).toThrow(
      'Invalid OUTREACH_V3_FULL_GENERATION_ENABLED value',
    );
  });

  it('requires the bounded V3 worker authority and multi-replica-safe claims', () => {
    const worker = read('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    // The closeout deliberately narrowed this worker from global Engagement
    // background ownership to a dedicated, flag-gated V3 authority so the main
    // API and engagement-api cannot race the same jobs. Assert the bounded gate
    // and assert the global one is NOT used.
    expect(worker).toContain('runtime.outreachV3FullGenerationWorkerEnabled()');
    expect(worker).toContain('assertOutreachV3FullGenerationWorker()');
    expect(worker).not.toContain('runtime.backgroundWorkersEnabled()');
    expect(worker).not.toContain("assertBackgroundOwner('outreach-v3-full-generation-worker')");
    expect(worker).toContain('FOR UPDATE OF i SKIP LOCKED');
    expect(worker).toContain("status: { in: ['claimed', 'generating'] }");
    expect(worker).toContain("data: { status: 'pending', claimedAt: null, error: null }");
  });

  it('rebuilds canonical V3 state and reauthorizes every slot before generation', () => {
    const worker = read('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    expect(worker).toContain('parseCampaignSpecV1');
    expect(worker).toContain('hashCampaignSpecV1');
    expect(worker).toContain('assertOutreachContextSponsorIsolation');
    expect(worker).toContain('this.preparation.prepareSlot');
    expect(worker).toContain('isOutreachV3FullGenerationJobCurrent');
    expect(worker).toContain('afterApproval');
    expect(worker).toContain('STATE_CHANGED_AFTER_GENERATION');
  });

  it('resumes crash-safe from exact-plan immutable versions without duplicate model spend', () => {
    const worker = read('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    expect(worker).toContain('existingVersionForPlan');
    expect(worker).toContain('outreachV3PlanHash !== descriptor.planHash');
    expect(worker).toContain('outreachV3SpecHash !== descriptor.specHash');
    expect(worker).toContain('contextPacketId');
  });

  it('stores no bearer token and has no send/provider-mail authority', () => {
    const worker = read('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    const request = read('src/outreach-v3/generation/outreach-v3-full-generation.service.ts');
    const descriptor = read('src/outreach-v3/generation/outreach-v3-full-generation-job.ts');
    for (const forbidden of [
      'Authorization:',
      'Bearer ',
      'accessToken:',
      'refreshToken:',
      'sendMail(',
      'OutreachSendIntentService',
      'GmailSendService',
      'MicrosoftGraph',
    ]) {
      expect(`${worker}\n${request}`).not.toContain(forbidden);
    }
    expect(request).toContain('payload: { generationKey: item.generationKey }');
    expect(descriptor).toContain("'apiKey'");
    expect(descriptor).toContain("'authHeader'");
    expect(descriptor).toContain('return null');
  });

  it('does not let the legacy job worker claim generate_v3 rows', () => {
    const legacy = read('src/engagement/outreach-job.service.ts');
    const worker = read('src/engagement-workers/outreach-v3-full-generation-worker.service.ts');
    expect(legacy).toContain("export type OutreachJobKind = 'generate' | 'send'");
    expect(legacy).not.toContain("kind === 'generate_v3'");
    expect(worker).toContain('OUTREACH_V3_FULL_GENERATION_JOB_KIND');
  });
});
