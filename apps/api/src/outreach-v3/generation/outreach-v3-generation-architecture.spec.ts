import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseOutreachV3GenerationEnabled } from './outreach-v3-generation.guard.js';
import { parseOutreachV3FullGenerationEnabled } from './outreach-v3-full-generation.guard.js';

function apiRoot(): string {
  const cwd = process.cwd();
  // process.cwd() uses the platform separator, so a bare endsWith('apps/api')
  // never matches on Windows and the path silently doubles to apps/api/apps/api.
  return cwd.split(sep).join('/').endsWith('apps/api') ? cwd : resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

describe('Outreach V3 historical generation access', () => {
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

  it('keeps sample approval exact and review-packet approval output-free', () => {
    const approval = readApi('src/outreach-v3/generation/outreach-v3-approach-approval.service.ts');
    const contract = readApi('src/outreach-v3/generation/outreach-v3-generation-approach.ts');
    const decision = readApi('src/outreach-v3/services/outreach-user-decision-event.service.ts');
    const reasoning = readApi('src/outreach-v3/reasoning/outreach-reasoning.service.ts');
    expect(approval).toContain("eventType: 'approach_approved'");
    expect(approval).toContain("eventType: 'review_packet_approved'");
    expect(approval).toContain('loadVersionContextPacketId');
    expect(approval).toContain('current.id === sample.versionId');
    expect(approval).toContain('current.contentHash === sample.contentHash');
    expect(approval).toContain('payloadHash: approval.approvalHash');
    expect(contract).toContain("'outreach_v3_review_packet_gate_v1'");
    expect(contract).toContain('sampleVersions: []');
    expect(decision).toContain("'approach_approved'");
    expect(decision).toContain("'review_packet_approved'");
    expect(decision).toContain('session.currentStateVersion !== input.expectedStateVersion');
    expect(reasoning).not.toContain('OutreachV3ApproachApprovalService');
    expect(reasoning).not.toContain('OutreachV3FullGenerationService');
  });

  it('retains historical jobs and approvals but has no retired producer routes or worker', () => {
    const controller = readApi('src/outreach-v3/generation/outreach-v3-generation.controller.ts');
    const workers = readApi('src/engagement-workers/engagement-workers.module.ts');
    for (const route of [
      "@Get('jobs/latest')",
      "@Get('jobs/:jobId')",
      "@Post('jobs/:jobId/cancel')",
      "@Post('approach-approval')",
    ])
      expect(controller).toContain(route);
    for (const route of [
      "@Post('samples')",
      "@Post('full')",
      "@Post('jobs/:jobId/items/:itemId/retry')",
    ])
      expect(controller).not.toContain(route);
    expect(workers).not.toContain('OutreachV3FullGenerationWorkerService');
    expect(workers).not.toContain('OutreachV3GenerationPreparationService');
  });
});
