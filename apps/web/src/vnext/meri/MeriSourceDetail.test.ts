import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('MeriSourceDetail — rebuilt against real citations', () => {
  test('takes real MeriCitation[] rather than evidence fixtures', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).toContain(
      "import type { MeriCitation } from '../../components/chat/chat-store.js'",
    );
    expect(source).toContain('citations: MeriCitation[]');
    expect(source).not.toContain('MERI_EVIDENCE_SOURCES');
  });

  test('drops fields and controls that have no endpoint rather than fabricating them', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).not.toContain('WHY_IT_MATTERS');
    expect(source).not.toContain('CLIENT FIT');
    expect(source).not.toContain('§ 214');
    expect(source).not.toContain('Include in active context');
    expect(source).not.toContain('for this session');
  });

  test('OPEN SOURCE only renders for a safe URL from the canonical reader or original citation', () => {
    const source = readMeri('MeriSourceDetail.tsx');
    expect(source).toContain(
      'safeMeriSourceUrl(first?.location) ?? safeMeriSourceUrl(citation?.url)',
    );
    expect(source).toContain('sourceUrl ? (');
    expect(source).toContain('href={sourceUrl}');
  });

  test('is reachable from a real citation click through Shell, Conversation, Message and Rail', () => {
    const message = readMeri('VNextMeriMessage.tsx');
    expect(message).toContain('onOpenSourceDetail(citations, index');
    expect(message).toContain('VIEW FULL SOURCE');
    expect(readMeri('VNextMeriConversation.tsx')).toContain(
      'onOpenSourceDetail={onOpenSourceDetail}',
    );
    expect(readMeri('VNextMeriShell.tsx')).toContain(
      'sourceSelection.open(citations, index, turnScope)',
    );
    expect(readMeri('VNextMeriContextRail.tsx')).toContain('<MeriSourceDetail');
  });

  test('resets when the active thread changes', () => {
    const shell = readMeri('VNextMeriShell.tsx');
    expect(shell).toContain('conversationId: controller.activeConversationId');
    const selection = readMeri('useMeriSourceSelection.ts');
    expect(selection).toContain(
      'selection?.key === key && selection?.conversationId === input.conversationId',
    );
    expect(selection).toContain(
      'transient?.key === key && transient?.conversationId === input.conversationId',
    );
    expect(selection).toContain('[key, input.conversationId]');
  });
});
