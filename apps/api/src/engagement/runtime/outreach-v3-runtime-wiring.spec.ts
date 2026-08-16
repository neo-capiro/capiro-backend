import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const API_SRC = path.resolve(process.cwd(), 'src');

function source(relative: string): string {
  return readFileSync(path.join(API_SRC, relative), 'utf8');
}

describe('Outreach V3 bounded runtime wiring', () => {
  it('threads the V3 generation authority through credentials, planning, style and drafting', () => {
    const request = source('outreach-v3/generation/outreach-v3-generation-request.ts');
    const gateway = source('engagement/generation/generation-gateway.service.ts');
    const plan = source('engagement/generation/message-plan.service.ts');
    const style = source('engagement/generation/author-style-profile.service.ts');
    const llm = source('engagement/llm-completion.service.ts');

    expect(request).toContain("runtimeAction: 'outreach_v3_generate'");
    expect(gateway).toContain('resolveOutreachV3Credentials(ctx)');
    expect(gateway).toContain('runtimeAction: request.runtimeAction');
    expect(plan).toContain('runtimeAction: request.runtimeAction');
    expect(style).toContain("runtimeAction?: 'outreach_generate' | 'outreach_v3_generate'");
    expect(llm).toContain("req.runtimeAction ?? 'outreach_generate'");
  });

  it('keeps Classic and V3 send-intent ownership disjoint', () => {
    const intents = source('engagement/outreach-send-intent.service.ts');
    const worker = source('engagement-workers/outreach-send-intent-worker.service.ts');

    expect(intents).toContain('isV3 === v3Only');
    expect(intents).toContain('FROM outreach_events');
    expect(intents).toContain("'outreach_v3_test_send'");
    expect(intents).toContain("'outreach_v3_send'");
    expect(worker).toContain('runWorkerSweep(v3Only)');
    expect(worker).toContain('outreachV3SendIntentWorkerEnabled()');
  });

  it('asserts the exact V3 action at the last provider boundary', () => {
    const mail = source('engagement/mail-sender.service.ts');
    const boundary = source('engagement/runtime/engagement-integration-runtime.boundary.ts');
    const module = source('engagement/engagement.module.ts');
    const send = source('outreach-v3/send/outreach-v3-send.service.ts');

    expect(mail).toContain('runtimeAction: EngagementSendRuntimeAction');
    expect(mail).toContain('this.runtimePolicy.assertExternalAction(runtimeAction');
    expect(boundary).toContain('resolveBoundaryAction(property, metadata.action, args)');
    expect(module).toContain('inject: [RAW_GOOGLE_TOKEN_SERVICE]');
    expect(send).toContain("? 'outreach_v3_test_send'");
    expect(send).toContain(": 'outreach_v3_send'");
  });
});
