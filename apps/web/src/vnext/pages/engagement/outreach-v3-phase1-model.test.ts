import { describe, expect, it } from 'vitest';
import { isGenerationTerminal, isSendTerminal } from './outreach-v3-phase1-model.js';
import { TERMINAL_GENERATION, TERMINAL_SEND } from './outreach-v3-phase1-shared.js';

// This codebase has two independent implementations of "is this outreach-v3
// job status terminal?" (an array + .includes() in outreach-v3-phase1-shared.tsx,
// and a Set + isGenerationTerminal()/isSendTerminal() in outreach-v3-phase1-model.ts),
// consumed separately across several workspace components. They have already
// drifted apart twice in production - once missing 'partial' in both places at
// once, caught only by a stuck-forever UI with zero error signal. These tests
// pin the real backend statuses (see OutreachV3FullGenerationWorkerService.
// finalizeJob()) so any future drift fails loudly here instead of live.
describe('generation/send terminal-status parity', () => {
  const BACKEND_GENERATION_STATUSES = ['complete', 'failed', 'canceled', 'cancelled', 'partial'];
  const BACKEND_NON_TERMINAL_GENERATION_STATUSES = ['queued', 'running'];

  it('isGenerationTerminal recognizes every terminal status the backend can produce', () => {
    for (const status of BACKEND_GENERATION_STATUSES) {
      expect(isGenerationTerminal(status)).toBe(true);
    }
    for (const status of BACKEND_NON_TERMINAL_GENERATION_STATUSES) {
      expect(isGenerationTerminal(status)).toBe(false);
    }
  });

  it('isGenerationTerminal and TERMINAL_GENERATION never disagree', () => {
    for (const status of BACKEND_GENERATION_STATUSES) {
      expect(isGenerationTerminal(status)).toBe(TERMINAL_GENERATION.includes(status));
    }
  });

  it('isSendTerminal and TERMINAL_SEND never disagree', () => {
    for (const status of TERMINAL_SEND) {
      expect(isSendTerminal(status)).toBe(true);
      expect(isSendTerminal(status)).toBe(TERMINAL_SEND.includes(status));
    }
  });
});
