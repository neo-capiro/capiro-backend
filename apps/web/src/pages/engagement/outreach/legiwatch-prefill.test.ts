/**
 * LW-05 regression tests for the LegiWatch → Outreach prefill handoff reader.
 * Shell-regression companion: these assert the reader contract directly
 * (validate → hydrate → clear), plus the "error loudly, never silently fall
 * back" rule for stale/malformed payloads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeLegiWatchHandoff,
  LW_OUTREACH_CONTEXT_KEY,
  prefillToWorkflowPatch,
} from './legiwatch-prefill.js';

const PREFILL = {
  clientId: 'client-1',
  clientName: 'Anduril',
  status: 'staged',
  autoSend: false,
  context: {
    hearing: {
      id: 'cm-119-119533',
      title: 'Shipbuilding readiness',
      committeeName: 'Seapower',
      calendarDate: '2026-09-01',
    },
    finding: { id: 'ins-1', title: 'Procurement gap', summary: 'Funding shortfall noted.' },
  },
};

function stage(payload: Record<string, unknown>, createdAt = Date.now()) {
  sessionStorage.setItem(LW_OUTREACH_CONTEXT_KEY, JSON.stringify({ ...payload, createdAt }));
}

describe('readLegiWatchHandoff via consume', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('validates and maps a fresh handoff, and clears the key after consumption', () => {
    stage({ prefill: PREFILL });

    const result = consumeLegiWatchHandoff('client-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handoff.prefill.clientId).toBe('client-1');
    }
    expect(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY)).toBeNull();

    const patch = prefillToWorkflowPatch(PREFILL);
    expect(patch.clientId).toBe('client-1');
    expect(patch.subject).toBe('Procurement gap');
    expect(patch.objective).toContain('Shipbuilding readiness');
  });

  it('fails loudly on a stale payload', () => {
    stage({ prefill: PREFILL }, Date.now() - 2 * 60 * 60 * 1000);

    const result = consumeLegiWatchHandoff('client-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale');
  });

  it('fails loudly on a malformed payload', () => {
    sessionStorage.setItem(LW_OUTREACH_CONTEXT_KEY, '{not json');

    const result = consumeLegiWatchHandoff('client-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('fails loudly on a client mismatch', () => {
    stage({ prefill: PREFILL });

    const result = consumeLegiWatchHandoff('client-2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('client-mismatch');
  });
});
