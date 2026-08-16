import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOutreachV3DraftsEnabled } from './outreach-v3-drafts.guard.js';

function apiRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith('apps/api') ? cwd : resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

describe('Outreach V3 exact draft approval architecture', () => {
  it('keeps draft author approval default-off and strict', () => {
    expect(parseOutreachV3DraftsEnabled(undefined)).toBe(false);
    expect(parseOutreachV3DraftsEnabled('')).toBe(false);
    expect(parseOutreachV3DraftsEnabled('true')).toBe(true);
    expect(parseOutreachV3DraftsEnabled('1')).toBe(true);
    expect(parseOutreachV3DraftsEnabled('false')).toBe(false);
    expect(() => parseOutreachV3DraftsEnabled('maybe')).toThrow(
      'Invalid OUTREACH_V3_DRAFTS_ENABLED value',
    );
  });

  it('composes V3 draft approval only into engagement-api', () => {
    const engagementApp = readApi('src/engagement-api.app.module.ts');
    const mainApp = readApi('src/app.module.ts');
    expect(engagementApp).toContain('OutreachV3DraftsModule');
    expect(mainApp).not.toContain('OutreachV3DraftsModule');
    expect(mainApp).not.toContain('outreach-v3/drafts/outreach-v3-drafts.module');
  });

  it('exposes only one human exact-version approval route', () => {
    const controller = readApi('src/outreach-v3/drafts/outreach-v3-drafts.controller.ts');
    expect(controller).toContain(
      "@Controller('engagement/outreach-v3/sessions/:sessionId/drafts')",
    );
    expect(controller).toContain("@Post(':versionId/approval')");
    expect(controller).toContain('OutreachV3StateGuard');
    expect(controller).toContain('OutreachV3DraftsGuard');
    expect(controller).not.toContain('preflight');
    expect(controller).not.toContain('sendIntent');
    expect(controller).not.toContain('sendMail');
  });

  it('pins approval to current artifact version plus persisted packet plan identity', () => {
    const service = readApi('src/outreach-v3/drafts/outreach-v3-draft-approval.service.ts');
    expect(service).toContain('loadVersionArtifactAndPacket');
    expect(service).toContain('persisted.currentVersion !== version.version');
    expect(service).toContain(
      'Number(packetRef.outreachV3StateVersion ?? NaN) === plan.stateVersion',
    );
    expect(service).toContain('asString(packetRef.outreachV3SpecHash) === plan.specHash');
    expect(service).toContain('asString(packetRef.outreachV3PlanHash) === plan.planHash');
    expect(service).toContain("eventType: 'draft_version_approved'");
    expect(service).toContain('payloadHash: approval.approvalHash');
    expect(service).not.toContain('version.contextPacketId');
    expect(service).not.toContain('OutreachSendIntentService');
    expect(service).not.toContain('GenerationGatewayService');
  });

  it('freezes the exact draft authority manifest', () => {
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-drafts-route-manifest.v1.json'),
    ) as {
      runtime: string;
      requiresStateFlag: string;
      featureFlag: string;
      disabledBehavior: number;
      routes: Array<Record<string, unknown>>;
      authority: Record<string, boolean>;
    };
    expect(manifest.runtime).toBe('engagement-api');
    expect(manifest.requiresStateFlag).toBe('OUTREACH_V3_STATE_ENABLED');
    expect(manifest.featureFlag).toBe('OUTREACH_V3_DRAFTS_ENABLED');
    expect(manifest.disabledBehavior).toBe(404);
    expect(manifest.routes).toEqual([
      {
        method: 'POST',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts/:versionId/approval',
        handler: 'approveVersion',
        humanDecisionOnly: true,
      },
    ]);
    expect(manifest.authority).toEqual({
      draftMutation: false,
      exactVersionAuthorApproval: true,
      preflight: false,
      sendIntent: false,
      mailProviderAction: false,
      memoryCommit: false,
    });
  });
});
