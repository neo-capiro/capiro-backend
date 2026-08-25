import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('governed-action approval gate', () => {
  // v6 turn-inspector integration moved the confirm-dialog state and the
  // MeriActionConfirm/MeriBulkActionConfirm dialogs themselves out of
  // VNextMeriConversation.tsx's PendingApprovalsInline and into
  // VNextMeriShell.tsx (both the transcript's "Review it" notice and the
  // rail's Approvals tab need to trigger the same dialogs, so they now live
  // once at the shared parent rather than duplicated per caller) — this test
  // moved with them, same assertions, new file.
  test('approve and approve-all open a confirmation dialog instead of executing directly', () => {
    const source = readMeri('VNextMeriShell.tsx');

    // Nothing upstream of the dialogs must be able to execute a governed write on click.
    expect(source).not.toMatch(/onClick=\{\(\) => void controller\.handleApprovePending\(/);
    expect(source).not.toMatch(/onClick=\{\(\) => void controller\.handleApproveAll\(\)\}/);

    // It routes through the dialogs, which own the actual calls.
    expect(source).toContain('setConfirmFor(target)');
    expect(source).toContain('setBulkOpen(true)');
    expect(source).toContain('<MeriActionConfirm');
    expect(source).toContain('<MeriBulkActionConfirm');
    expect(source).toContain('controller.handleApprovePending(target.proposalId)');
    expect(source).toContain('controller.handleApproveAll()');
  });

  test('confirmation is gated on an explicit acknowledgement', () => {
    const source = readMeri('MeriActionConfirm.tsx');
    expect(source).toContain('aria-checked={acknowledged}');
    // Both dialogs disable submit until the operator acknowledges.
    expect(source.match(/disabled=\{!acknowledged \|\| busy\}/g)?.length).toBe(2);
  });

  test('the dialog reads server proposal fields and never invents payload detail', () => {
    const source = readMeri('MeriActionConfirm.tsx');
    for (const field of [
      'preview.fields',
      'preview.counts',
      'preview.leavesFirm',
      'preview.reversible',
      'policy?.packKey',
      'policy?.decisionHash',
      'proposal.expiresAt',
      'proposal.attemptCount',
    ]) {
      expect(source).toContain(field);
    }
    // No prototype payloads.
    for (const fabricated of ['Jordan Reyes', 'jreyes@', 'Lockheed', '7C41-8802', 'capiro-governance']) {
      expect(source).not.toContain(fabricated);
    }
  });

  test('a held dialog is released when the server retires the proposal', () => {
    const source = readMeri('VNextMeriShell.tsx');
    expect(source).toContain('if (!live) setConfirmFor(null);');
    expect(source).toContain('if (bulkOpen && proposedApprovals.length === 0) setBulkOpen(false);');
  });
});
