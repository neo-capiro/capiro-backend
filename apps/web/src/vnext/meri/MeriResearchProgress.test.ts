import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');
const chatDir = resolve(process.cwd(), 'src/components/chat');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

function readChat(name: string): string {
  return readFileSync(resolve(chatDir, name), 'utf8');
}

describe('MeriResearchProgress', () => {
  test('renders elapsed time with an indeterminate bar, never a completion percentage from a time budget', () => {
    const source = readMeri('MeriResearchProgress.tsx');
    expect(source).toContain('progress.elapsedMs');
    expect(source).toContain("' ELAPSED'");
    expect(source).not.toMatch(/progress[!?]?\.budgetMs/);
    // A deadline is not work completed, even when a server budget is present.
    expect(source).toContain('vnext-meri__research-bar-indeterminate');
  });

  test('is gated on isResearchStreaming, not the generic isStreaming flag', () => {
    const message = readMeri('VNextMeriMessage.tsx');
    expect(message).toContain('controller.isResearchStreaming');
    expect(message).toContain('showResearchProgress');
    // The two heroes are mutually exclusive on one message.
    expect(message).toContain('!showResearchProgress');
  });

  test('reuses the shared step renderer rather than a third copy of STEP tones', () => {
    const source = readMeri('MeriResearchProgress.tsx');
    expect(source).toContain("import { MeriAgentSteps } from './MeriAgentSteps.js'");
    expect(source).not.toMatch(/dotBg:\s*'#101828'/);
  });
});

describe('research progress plumbing (useMeriChatController)', () => {
  test('progress events populate real state instead of only composing message text', () => {
    const source = readChat('useMeriChatController.ts');
    // Both the plan-stream and gather/synthesize handlers must capture the
    // event into researchProgress, not just interpolate it into a string.
    const progressSetCalls = source.match(
      /setResearchProgress\(\{\s*note: e\.note,\s*elapsedMs: e\.elapsedMs \?\? 0,\s*budgetMs: e\.budgetMs,/g,
    );
    expect(progressSetCalls?.length).toBe(2);
  });

  test('plan and gather finally reset research state only for their own stream epoch', () => {
    const source = readChat('useMeriChatController.ts');
    const cleanups = source.match(
      /finally\s*\{\s*if \(streamEpoch === streamEpochRef\.current\) \{\s*(?:setStreaming\(false\);\s*)?setIsResearchStreaming\(false\);\s*setResearchProgress\(null\);\s*\}/g,
    );
    expect(cleanups?.length).toBe(2);
  });

  test('formatElapsed is exported and shared rather than reimplemented in the component', () => {
    const controller = readChat('useMeriChatController.ts');
    const component = readMeri('MeriResearchProgress.tsx');
    expect(controller).toContain('export function formatElapsed');
    expect(component).toContain(
      "import { formatElapsed } from '../../components/chat/useMeriChatController.js'",
    );
  });
});
