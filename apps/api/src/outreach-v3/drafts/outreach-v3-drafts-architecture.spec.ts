import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseOutreachV3DraftsEnabled } from './outreach-v3-drafts.guard.js';

function apiRoot(): string {
  const cwd = process.cwd();
  // process.cwd() uses the platform separator, so a bare endsWith('apps/api')
  // never matches on Windows and the path silently doubles to apps/api/apps/api.
  return cwd.split(sep).join('/').endsWith('apps/api') ? cwd : resolve(cwd, 'apps/api');
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
    // Frozen against the real OutreachV3DraftsController surface: read paths
    // plus append-only revise plus governed refine plus exact-version approval.
    // Draft mutation is append-only (each revise/refine creates a new immutable
    // version) rather than absent, which is what `appendOnlyDraftMutation`
    // records.
    expect(manifest.routes).toEqual([
      {
        method: 'GET',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts',
        handler: 'list',
      },
      {
        method: 'GET',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts/:versionId',
        handler: 'getVersion',
      },
      {
        method: 'POST',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts/:artifactId/versions',
        handler: 'revise',
        humanDecisionOnly: true,
      },
      {
        method: 'POST',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts/:artifactId/refine',
        handler: 'refine',
        humanDecisionOnly: true,
      },
      {
        method: 'POST',
        path: '/api/engagement/outreach-v3/sessions/:sessionId/drafts/:versionId/approval',
        handler: 'approveVersion',
        humanDecisionOnly: true,
      },
    ]);
    expect(manifest.authority).toEqual({
      appendOnlyDraftMutation: true,
      exactVersionAuthorApproval: true,
      preflight: false,
      sendIntent: false,
      mailProviderAction: false,
      memoryCommit: false,
    });
  });
});
