import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriMemoryTab', () => {
  test('is wired to the same controller state and handlers the legacy drawer uses, not a new fetch', () => {
    const rail = readMeri('VNextMeriContextRail.tsx');
    expect(rail).toContain('controller.learnedMemories');
    expect(rail).toContain('controller.forgottenMemories');
    expect(rail).toContain('controller.saveMemoryEdit');
    expect(rail).toContain('controller.forgetMemory');
    expect(rail).toContain('controller.undoForgetMemory');
    expect(rail).toContain('controller.suggestMemoryCorrection');
  });

  test('does not fetch its own broader memory list — mutations only know about the recent-5 state', () => {
    const source = readMeri('MeriMemoryTab.tsx');
    expect(source).not.toContain('useApi');
    expect(source).not.toMatch(/api\.get\(/);
    expect(source).not.toMatch(/fetch\(/);
  });

  test('does not double the rail section padding', () => {
    const source = readMeri('MeriMemoryTab.tsx');
    expect(source).toContain("className=\"vnext-meri__rail-section-content\"");
    expect(source).not.toMatch(/padding:\s*'18px 20px/);
  });

  test('memory is a real MeriContextSection value, not a separate ad hoc flag', () => {
    const prefs = readMeri('meri-prefs.ts');
    expect(prefs).toMatch(/'context' \| 'sources' \| 'actions' \| 'memory'/);
    const rail = readMeri('VNextMeriContextRail.tsx');
    expect(rail).toContain("key: 'memory'");
  });
});
