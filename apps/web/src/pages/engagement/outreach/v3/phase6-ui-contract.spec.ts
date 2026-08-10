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

  it('implements the accepted standalone one-workbench conversation contract', () => {
    const route = source('OutreachV3Route.tsx');
    const conversation = source('OutreachConversation.tsx');
    const brief = source('CampaignBrief.tsx');
    const standaloneCss = source('outreach-v3-standalone.css');

    expect(route).toContain('<main className="ov3-workbench">');
    expect(route).not.toContain('className="ov3-workspace"');
    expect(route).toContain("{ key: 'goal', label: 'Goal'");
    expect(route).toContain("{ key: 'targets', label: 'Targets'");
    expect(route).toContain("{ key: 'delivery', label: 'Delivery'");
    expect(route).toContain("{ key: 'context', label: 'Context'");
    expect(route).toContain("label: 'Drafts'");
    expect(route).toContain("{ key: 'send', label: 'Send'");
    expect(route).toContain("members: ['goal', 'sponsor']");
    expect(route).toContain("members: ['strategy', 'ready_for_generation']");
    expect(route).toContain("import './outreach-v3-standalone.css';");

    expect(conversation).toContain('ov3-conversation-dock');
    expect(conversation).toContain('ov3-conversation-history');
    expect(conversation).toContain('ov3-live-turn');
    expect(conversation).toContain('ov3-docked-composer');
    expect(conversation).toContain('typed instructions become proposals and never apply themselves');

    expect(brief).toContain('ov3-brief-strip');
    expect(brief).toContain('onSelectStage');

    expect(standaloneCss).toContain('max-width: 1092px');
    expect(standaloneCss).toContain('grid-template-columns: repeat(6');
    expect(standaloneCss).toContain('.ov3-conversation-history');
    expect(standaloneCss).not.toContain('grid-template-columns: minmax(310px, 0.82fr)');
  });

  it('freezes the exact standalone layout supersession artifact hash', () => {
    const manifest = readFileSync(
      path.join(ROOT, 'docs/plans/outreach-v3/revised-phase-6-standalone-layout-supersession.md'),
      'utf8',
    );
    expect(manifest).toContain('84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453');
    expect(manifest).toContain('The desktop screen is **not** a permanent conversation/work split.');
    expect(manifest).toContain('Goal → Targets → Delivery → Context → Drafts → Send');
    expect(manifest).toContain('Typing “send it” must never send from Phase 6.');
  });

  it('archives the earlier accepted Figma implementation nodes as component/style reference', () => {
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
