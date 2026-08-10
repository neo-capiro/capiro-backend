import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(path.join(DIR, name), 'utf8');

describe('Outreach V3 planning-surface architecture', () => {
  it('never projects a recommendation into the canonical delivery selection', () => {
    const route = source('OutreachV3Route.tsx');
    const delivery = source('DeliveryDecisionSurface.tsx');
    expect(route).not.toContain('decisionSession');
    expect(route).not.toContain('recommendedPattern')
    expect(route).toContain('session={session}');
    expect(delivery).toContain('Meri may explain or recommend');
    expect(delivery).toContain('Cards select. Continue commits');
  });

  it('requires shared-recipient visibility acknowledgement before committing', () => {
    const delivery = source('DeliveryDecisionSurface.tsx');
    expect(delivery).toContain("pattern === 'shared_thread' && !sharedVisibilityAccepted");
    expect(delivery).toContain('recipients can see one another and may reply all');
    expect(delivery).toContain("disabled={pattern === 'shared_thread' && value === 'high'}");
  });

  it('keeps strategy editable and outside generation authority', () => {
    const strategy = source('StrategyDecisionSurface.tsx');
    expect(strategy).toContain('Recommendations remain editable');
    expect(strategy).toContain('strategyCommands');
    expect(strategy).not.toMatch(/REQUEST_(?:SAMPLE|FULL)_GENERATION/);
    expect(strategy).not.toContain('send-intents');
  });

  it('ends Phase 6 at a truthful planning-complete boundary', () => {
    const ready = source('ReadyForGenerationSurface.tsx');
    expect(ready).toContain('The product stops safely here');
    expect(ready).toContain('No sender, test send, final send, provider call, or delivery retry');
    expect(ready).not.toMatch(/onGenerate|createSendIntent|sendCampaign/);
  });
});
