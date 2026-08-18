import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriAgentSteps (shared step-row rendering)', () => {
  test('only real TrustStep statuses have a tone — queued/skipped are not reachable', () => {
    const source = readMeri('MeriAgentSteps.tsx');
    expect(source).toContain('done:');
    expect(source).toContain('running:');
    expect(source).toContain('error:');
    // The prototype's STEP dictionary has these two; TrustStep never reports
    // them, so they must not appear as tone keys here.
    expect(source).not.toMatch(/queued:\s*\{/);
    expect(source).not.toMatch(/skipped:\s*\{/);
  });

  test('is shared, not duplicated, between the two agent-run heroes', () => {
    const workPerformed = readMeri('MeriWorkPerformed.tsx');
    const researchProgress = readMeri('MeriResearchProgress.tsx');
    expect(workPerformed).toContain("import { MeriAgentSteps } from './MeriAgentSteps.js'");
    expect(researchProgress).toContain("import { MeriAgentSteps } from './MeriAgentSteps.js'");
    expect(workPerformed).not.toMatch(/queued:\s*\{/);
    expect(researchProgress).not.toMatch(/queued:\s*\{/);
  });
});

describe('MeriWorkPerformed', () => {
  test('reuses WorkPerformed intent labels rather than a second copy of the map', () => {
    const source = readMeri('MeriWorkPerformed.tsx');
    expect(source).toContain("import { INTENT_LABELS");
    expect(source).toContain("../../components/chat/WorkPerformed.js");
  });

  test('progress is derived from step counts, not a fabricated timer', () => {
    const source = readMeri('MeriWorkPerformed.tsx');
    expect(source).toContain('doneCount / toolCount');
    expect(source).not.toContain('elapsedMs');
    expect(source).not.toContain('budgetMs');
  });

  test('does not accept assumptions/warnings/contextPacketId — the real call site never populates them', () => {
    const source = readMeri('MeriWorkPerformed.tsx');
    const props = source.slice(
      source.indexOf('interface MeriWorkPerformedProps'),
      source.indexOf('export function MeriWorkPerformed'),
    );
    expect(props).not.toContain('assumptions');
    expect(props).not.toContain('warnings');
    expect(props).not.toContain('contextPacketId');
  });

  test('animated elements use CSS classes, not inline animation, so reduced-motion can turn them off', () => {
    const workPerformed = readMeri('MeriWorkPerformed.tsx');
    const steps = readMeri('MeriAgentSteps.tsx');
    expect(workPerformed).not.toMatch(/animation:\s*tone\.spin/);
    expect(workPerformed).toContain('vnext-meri__work-source-dot');
    expect(steps).not.toMatch(/animation:\s*tone\.spin/);
    expect(steps).toContain('vnext-meri__work-step-icon');
    const css = readMeri('vnext-meri.css');
    expect(css).toContain('.vnext-meri__work-step-icon.is-running');
    expect(css).toContain('.vnext-meri__work-source-dot.is-live');
  });

  test('replaces the bare <details> disclosure in the live message renderer', () => {
    const source = readMeri('VNextMeriMessage.tsx');
    expect(source).toContain('<MeriWorkPerformed');
    expect(source).not.toContain('<details');
    expect(source).not.toContain('Execution evidence');
  });
});
