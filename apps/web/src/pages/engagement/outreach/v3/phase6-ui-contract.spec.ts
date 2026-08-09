import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_PREVIEW_ROUTE_PATTERNS } from '../../../../lib/engagement-api-preview-routes.generated.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../../../../../../..');

function source(name: string): string {
  return readFileSync(path.join(DIR, name), 'utf8');
}

describe('Outreach V3 Phase 6 UI contract', () => {
  it('keeps generation, approval, preflight, and send authority out of the browser client', () => {
    const api = source('outreach-v3-api.ts');
    expect(api).not.toMatch(/\/generate(?:-|\/|')/);
    expect(api).not.toMatch(/\/send(?:-|\/|')/);
    expect(api).not.toContain('send-intents');
    expect(api).not.toContain('send-test');
    expect(api).not.toContain('draft-artifacts');
  });

  it('requires both explicit preview modes and preserves Classic drafts', () => {
    const router = source('OutreachWizardRouter.tsx');
    expect(router).toContain("previewMode === 'v3' && isEngagementPreviewActive() && !hasClassicDraft");
    expect(router).toContain('initialRecord || props.initialDraftId');
    expect(router).toContain('<ClassicOutreachWizard {...props} />');
  });

  it('routes every V3 Phase 2-5 browser endpoint through exact engagement preview matching', () => {
    const expected = [
      '^/api/engagement/outreach-v3/sessions$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/commands$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/proposals/[^/]+/apply$',
      '^/api/engagement/outreach-v3/reasoning/conversations/[^/]+/turns$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/targets/search$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/targets/profile$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/context/memory/search$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/context/government/search$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/context/review$',
      '^/api/engagement/outreach-v3/sessions/[^/]+/context/strategy$',
    ];
    for (const pattern of expected) expect(ENGAGEMENT_PREVIEW_ROUTE_PATTERNS).toContain(pattern);
  });

  it('uses backend readiness as the stage authority and ignores only intentional future blockers', () => {
    const hook = source('useOutreachV3Session.ts');
    const brief = source('CampaignBrief.tsx');
    expect(hook).toContain('stageFromCanonicalReadiness');
    expect(hook).toContain("blockers.has('TARGET_CRITERIA_MISSING')");
    expect(hook).toContain("blockers.has('CONTEXT_HAS_UNVERIFIED_EVIDENCE')");
    expect(hook).toContain("'GENERATION_NOT_AVAILABLE'");
    expect(hook).toContain('outreachV3PlanningBlockerCodes');
    expect(brief).toContain('outreachV3PlanningBlockerCodes(readiness)');
  });

  it('recovers reasoning continuity without reloading or replacing canonical campaign state', () => {
    const hook = source('useOutreachV3Session.ts');
    const conversation = source('OutreachConversation.tsx');
    const route = source('OutreachV3Route.tsx');
    expect(hook).toContain('retryReasoning');
    expect(hook).toContain('resetQueries');
    expect(conversation).not.toContain('window.location.reload');
    expect(route).toContain('controller.retryReasoning()');
  });

  it('archives the exact accepted Figma implementation nodes', () => {
    const manifest = readFileSync(
      path.join(ROOT, 'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md'),
      'utf8',
    );
    for (const node of [
      '634:2703',
      '638:2906',
      '640:3097',
      '643:3350',
      '645:3555',
      '646:3746',
      '648:3987',
      '649:4168',
      '650:4380',
      '651:4576',
      '652:4774',
      '654:4967',
      '655:5028',
      '656:5099',
      '661:5304',
    ]) {
      expect(manifest).toContain(node);
    }
  });

  it('has no direct preview-header literal or unauthorized browser-only Campaign Spec store', () => {
    const files = readdirSync(DIR).filter((name) => /\.(ts|tsx)$/.test(name));
    const all = files.map((name) => source(name)).join('\n');
    expect(all).not.toContain('X-Capiro-Engagement-Preview');
    expect(all).not.toMatch(/localStorage\.setItem\([^)]*campaign/i);
    expect(all).not.toMatch(/useState<OutreachV3CampaignSpec/);
  });
});