import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriSourceDetail — rebuilt against real citations', () => {
  test('takes real MeriCitation[], not the MERI_EVIDENCE_SOURCES fixture', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).toContain("import type { MeriCitation } from '../../components/chat/chat-store.js'");
    expect(source).toContain('citations: MeriCitation[]');
    expect(source).not.toContain('MERI_EVIDENCE_SOURCES');
  });

  test('drops the three fields that had no real backing rather than fabricating them', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).not.toContain('WHY_IT_MATTERS');
    expect(source).not.toContain('CLIENT FIT');
    expect(source).not.toContain('§ 214');
    expect(source).not.toContain('Lockheed Martin');
  });

  test('OPEN SOURCE only renders when the citation actually has a url', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).toContain('citation.url ? (');
  });

  test('the include-in-context toggle is honestly session-scoped, not claimed as persisted', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).toContain('for this session');
  });

  test('is reachable from a real citation click, wired through Shell -> Conversation -> Message -> Rail', () => {
    const message = readMeri('VNextMeriMessage.tsx');
    expect(message).toContain('onOpenSourceDetail(citations, index');
    expect(message).toContain('VIEW FULL SOURCE');

    const conversation = readMeri('VNextMeriConversation.tsx');
    expect(conversation).toContain('onOpenSourceDetail={onOpenSourceDetail}');

    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain('setActiveSourceDetail({ citations, index })');

    const rail = readMeri('VNextMeriContextRail.tsx');
    expect(rail).toContain('activeSourceDetail');
    expect(rail).toContain('<MeriSourceDetail');
  });

  test('resets when the active thread changes, so it never shows a stale thread\'s citations', () => {
    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toMatch(/setActiveSourceDetail\(null\);\s*\}, \[controller\.activeConversationId\]\);/);
  });
});

describe('MeriManageContext stays unwired — correcting the earlier record', () => {
  test('MeriContextSheet remains the real "Manage context" trigger, not the fixture-driven MeriManageContext', () => {
    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain('<MeriContextSheet');
    // The earlier PR #1045 description said this swap would happen; it was
    // correctly never done, because MeriManageContext's add/remove/apply are
    // toast-only stubs and there is no thread-context-membership endpoint —
    // wiring it would replace an honest read-only view with dead controls.
    expect(shell).not.toContain('<MeriManageContext');
  });
});
