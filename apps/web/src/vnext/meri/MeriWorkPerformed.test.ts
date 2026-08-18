import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriWorkPerformed', () => {
  test('only real TrustStep statuses have a tone — queued/skipped are not reachable', () => {
    const source = readMeri('MeriWorkPerformed.tsx');
    expect(source).toContain("done:");
    expect(source).toContain("running:");
    expect(source).toContain("error:");
    // The prototype's STEP dictionary has these two; TrustStep never reports
    // them, so they must not appear as tone keys here.
    expect(source).not.toMatch(/queued:\s*\{/);
    expect(source).not.toMatch(/skipped:\s*\{/);
  });

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
    const source = readMeri('MeriWorkPerformed.tsx');
    expect(source).not.toMatch(/animation:\s*tone\.spin/);
    expect(source).toContain('vnext-meri__work-step-icon');
    expect(source).toContain('vnext-meri__work-source-dot');
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
