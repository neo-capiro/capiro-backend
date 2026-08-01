import { describe, expect, it } from '@jest/globals';
import {
  SEND_DISABLED_REASON,
  computeSendToken,
  sendEnabled,
  verifySendToken,
  type SendTokenInput,
} from './send-approval.js';

/*
 * Stage G send-approval token machinery. Asserts the token is a stable function
 * of a canonical serialization, that ANY hashed-field change invalidates it,
 * that a token is bound to its originating run (no cross-run reuse), and that
 * the Stage-H send seam is OFF by default.
 */

const BASE: SendTokenInput = {
  message: 'Please advance the markup vote timeline with the chair.',
  recipients: ['staff.a@example.gov', 'staff.b@example.gov'],
  ask: 'Confirm the hearing date',
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-15T00:00:00.000Z',
};

describe('computeSendToken', () => {
  it('is a 64-char sha256 hex string', () => {
    expect(computeSendToken(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across repeated calls with identical input', () => {
    expect(computeSendToken(BASE)).toBe(computeSendToken({ ...BASE }));
  });

  it('normalizes whitespace in message / ask (collapse + trim => same token)', () => {
    const noisy: SendTokenInput = {
      ...BASE,
      message: '  Please advance   the markup\n\nvote timeline with the chair. ',
      ask: '\tConfirm the   hearing date  ',
    };
    expect(computeSendToken(noisy)).toBe(computeSendToken(BASE));
  });

  it('is insensitive to recipient ordering', () => {
    const reordered: SendTokenInput = {
      ...BASE,
      recipients: ['staff.b@example.gov', 'staff.a@example.gov'],
    };
    expect(computeSendToken(reordered)).toBe(computeSendToken(BASE));
  });

  it('is insensitive to duplicate recipients + recipient whitespace', () => {
    const dup: SendTokenInput = {
      ...BASE,
      recipients: [' staff.a@example.gov ', 'staff.b@example.gov', 'staff.a@example.gov'],
    };
    expect(computeSendToken(dup)).toBe(computeSendToken(BASE));
  });

  it('changes when the message changes', () => {
    expect(computeSendToken({ ...BASE, message: 'A different message entirely.' })).not.toBe(
      computeSendToken(BASE),
    );
  });

  it('changes when a recipient is added', () => {
    expect(
      computeSendToken({ ...BASE, recipients: [...BASE.recipients, 'staff.c@example.gov'] }),
    ).not.toBe(computeSendToken(BASE));
  });

  it('changes when the ask changes', () => {
    expect(computeSendToken({ ...BASE, ask: 'Confirm the vote count' })).not.toBe(
      computeSendToken(BASE),
    );
  });

  it('changes when windowStart changes', () => {
    expect(computeSendToken({ ...BASE, windowStart: '2026-08-02T00:00:00.000Z' })).not.toBe(
      computeSendToken(BASE),
    );
  });

  it('changes when windowEnd changes', () => {
    expect(computeSendToken({ ...BASE, windowEnd: null })).not.toBe(computeSendToken(BASE));
  });
});

describe('verifySendToken', () => {
  const RUN = 'run-123';

  it('accepts a matching token minted for the same run', () => {
    const token = computeSendToken(BASE);
    expect(verifySendToken(BASE, token, RUN, RUN)).toEqual({ valid: true });
  });

  it('rejects a token minted for a different run (no standing approval)', () => {
    const token = computeSendToken(BASE);
    const result = verifySendToken(BASE, token, RUN, 'run-999');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/different run/i);
  });

  it('rejects a token whose hashed input was tampered with after approval', () => {
    const approved = computeSendToken(BASE);
    const tampered: SendTokenInput = {
      ...BASE,
      recipients: [...BASE.recipients, 'attacker@x.gov'],
    };
    const result = verifySendToken(tampered, approved, RUN, RUN);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/i);
  });

  it('rejects an empty presented token', () => {
    expect(verifySendToken(BASE, '', RUN, RUN)).toEqual({
      valid: false,
      reason: expect.stringMatching(/no send-approval token/i),
    });
  });

  it('rejects when the presenting runId is empty', () => {
    const token = computeSendToken(BASE);
    expect(verifySendToken(BASE, token, '', RUN).valid).toBe(false);
  });
});

describe('sendEnabled (Stage-H seam)', () => {
  it('is false by default (env unset in Stage G)', () => {
    expect(sendEnabled({})).toBe(false);
  });

  it("is false unless STRATEGY_EXECUTION_SEND_ENABLED is exactly 'true'", () => {
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: 'false' })).toBe(false);
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: '1' })).toBe(false);
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: 'TRUE' })).toBe(false);
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: '' })).toBe(false);
  });

  it("is true only for the exact 'true' opt-in", () => {
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: 'true' })).toBe(true);
  });
});

describe('SEND_DISABLED_REASON', () => {
  it('names the Stage-H gate', () => {
    expect(SEND_DISABLED_REASON).toBe('External send is disabled until Stage H security review');
  });
});
