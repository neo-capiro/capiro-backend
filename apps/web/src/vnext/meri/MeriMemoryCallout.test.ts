import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriMemoryCallout', () => {
  test('never claims a specific answer used a specific memory — no such linkage exists in the data', () => {
    const source = readMeri('MeriMemoryCallout.tsx');
    // The real claim is narrower: a pending candidate exists, not "this
    // answer used it". Guard against regressing to the unsupported framing.
    expect(source).not.toMatch(/this answer (used|is based on)/i);
    expect(source).toContain("state === 'pending_review'");
  });

  test('renders nothing when there is no pending candidate, rather than a generic memory summary', () => {
    const source = readMeri('MeriMemoryCallout.tsx');
    expect(source).toContain('if (pending.length === 0) return null');
  });

  test('is wired to the last settled assistant turn, and opens the real rail Memory tab', () => {
    const message = readMeri('VNextMeriMessage.tsx');
    expect(message).toContain('isLastAssistant && !messageIsStreaming');
    expect(message).toContain('controller.learnedMemories');
    expect(message).toContain('onOpenMemory={onOpenMemory}');

    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain("onOpenMemory={() => expandSection('memory')}");
  });
});
