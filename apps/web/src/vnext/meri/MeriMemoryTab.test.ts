import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('Meri institutional memory', () => {
  test('uses canonical governance queues and never the legacy Clio memory adapter', () => {
    const source = readMeri('MeriMemoryTab.tsx');
    expect(source).toContain('/api/memory/review/candidates');
    expect(source).toContain('/api/memory/proposals');
    expect(source).toContain('/api/memory/proposals/');
    expect(source).not.toContain('/api/clio/memory');
    expect(source).not.toContain('MeriLearnedMemory');
    expect(source).not.toContain('learnedMemories');
  });

  test('renders active recall only from the server-compiled Context Packet', () => {
    const source = readMeri('MeriMemoryTab.tsx');
    expect(source).toContain('MeriContextPacket');
    expect(source).toContain('(packet?.items ?? []).filter(isGovernedMemoryItem)');
    expect(source).toContain('No governed memory was included in the current context packet');
  });

  test('enforces server-authoritative review and withdraw capabilities in the UI', () => {
    const source = readMeri('MeriMemoryTab.tsx');
    expect(source).toContain('candidate.capabilities.approve');
    expect(source).toContain('candidate.capabilities.reject');
    expect(source).toContain('candidate.capabilities.withdraw');
    // Every canonical rejection now requires a reason, regardless of kind.
    expect(source).toContain('disabled={!rejectReason.trim() || decision.isPending}');
    expect(source).toContain('reason: rejectReason.trim()');
    expect(source).toContain("decision: 'reject'");
  });

  test('the rail passes the real packet and uses governed counts', () => {
    const rail = readMeri('VNextMeriContextRail.tsx');
    expect(rail).toContain('<MeriMemoryTab packet={packet} />');
    expect(rail).toContain('useMeriGovernedMemoryQueues');
    expect(rail).not.toContain('controller.learnedMemories');
    expect(rail).not.toContain('controller.forgottenMemories');
  });

  test('memory remains a real MeriContextSection value', () => {
    const prefs = readMeri('meri-prefs.ts');
    expect(prefs).toMatch(/'context' \| 'sources' \| 'actions' \| 'memory'/);
    expect(readMeri('VNextMeriContextRail.tsx')).toContain("key: 'memory'");
  });
});
