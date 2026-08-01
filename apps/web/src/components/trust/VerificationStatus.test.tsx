import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { deriveVerificationDisplay, VerificationStatus } from './VerificationStatus.js';

describe('deriveVerificationDisplay', () => {
  it('never hides a missing verification run', () => {
    expect(deriveVerificationDisplay({}).state).toBe('not_verified');
    expect(deriveVerificationDisplay({}).label).toBe('Not verified');
  });

  it('distinguishes unavailable from no issues found', () => {
    const display = deriveVerificationDisplay({
      ran: false,
      unavailableReason: 'Verifier timed out.',
    });
    expect(display.state).toBe('unavailable');
    expect(display.label).toBe('Verification unavailable');
    expect(display.detail).toBe('Verifier timed out.');
  });

  it('reports supported and unsupported claim counts', () => {
    const display = deriveVerificationDisplay({
      verification: { totalCount: 5, unsupportedCount: 2 },
    });
    expect(display.state).toBe('partially_verified');
    expect(display.detail).toBe('3 supported · 2 unsupported');
  });

  it('uses Verified only when a run checked claims and all passed', () => {
    const display = deriveVerificationDisplay({
      verification: { totalCount: 3, unsupportedCount: 0 },
    });
    expect(display.state).toBe('verified');
    expect(display.label).toBe('Verified');
  });

  it('downgrades to partial when a high-severity deterministic finding exists', () => {
    const display = deriveVerificationDisplay({
      verification: { totalCount: 2, unsupportedCount: 0 },
      findings: [{ severity: 'high', detail: 'Authorization was described as appropriation.' }],
    });
    expect(display.state).toBe('partially_verified');
  });
});

describe('VerificationStatus', () => {
  it('requires an explicit acknowledgment callback for high-risk findings', () => {
    const onAcknowledge = vi.fn();
    const display = deriveVerificationDisplay({
      verification: { totalCount: 1, unsupportedCount: 0 },
      findings: [{ severity: 'critical', detail: 'Unsupported enactment claim.' }],
    });
    render(
      <VerificationStatus display={display} acknowledged={false} onAcknowledge={onAcknowledge} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onAcknowledge).toHaveBeenCalledWith(true);
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported enactment claim');
  });
});
