import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriMemoryCallout', () => {
  test('never claims a specific answer used or created a specific memory', () => {
    const source = readMeri('MeriMemoryCallout.tsx');
    expect(source).not.toMatch(/this answer (used|is based on|created)/i);
    expect(source).toContain('useMeriGovernedMemoryQueues');
    expect(source).not.toContain('MeriLearnedMemory');
  });

  test('renders only when a governed review or owned proposal needs attention', () => {
    const source = readMeri('MeriMemoryCallout.tsx');
    expect(source).toContain('reviewCount === 0 && pendingProposalCount === 0');
    expect(source).toContain('return null');
    expect(source).toContain('INSTITUTIONAL MEMORY');
  });

  test('is wired to the last settled assistant turn and opens the Memory rail', () => {
    const message = readMeri('VNextMeriMessage.tsx');
    expect(message).toContain('isLastAssistant && !messageIsStreaming');
    expect(message).toContain('<MeriMemoryCallout onOpenMemory={onOpenMemory} />');
    expect(message).not.toContain('controller.learnedMemories');

    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain("onOpenMemory={() => expandSection('memory')}");
  });
});
