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
  // MeriApprovalsTab.tsx (the rail's Approvals tab) — which, unlike the old
  // inline card, is deliberately decoupled from `controller`: it takes plain
  // onApprove/onApproveAll/onDismiss callbacks instead. That means the gate
  // (Approve click -> setConfirmFor -> MeriActionConfirm -> onConfirm) and
  // the actual controller call are now one layer apart by design — this
  // test checks each at the layer it actually lives.
  test('the Approvals tab gates approve/approve-all on a confirmation dialog before calling its callback', () => {
    const source = readMeri('MeriApprovalsTab.tsx');

    // The Approve/Retry button opens the dialog, it does not call onApprove directly.
    expect(source).not.toMatch(/onClick=\{\(\) => onApprove\(/);
    expect(source).toContain('onClick={() => setConfirmFor(proposal)}');
    expect(source).toContain('onClick={() => setBulkOpen(true)}');
    expect(source).toContain('<MeriActionConfirm');
    expect(source).toContain('<MeriBulkActionConfirm');
    // Only the dialogs' onConfirm may call the callbacks.
    expect(source).toContain('if (target) onApprove(target.proposalId)');
    expect(source).toContain('onApproveAll()');
  });

  test('the callbacks the dialog ultimately triggers reach the controller, not a second dialog', () => {
    const source = readMeri('VNextMeriShell.tsx');
    // Shell wires the turn inspector's onApprove/onApproveAll straight to the
    // controller — MeriApprovalsTab already gated the click on its own
    // dialog before either of these is ever called, so gating a second time
    // here would show the confirmation twice in sequence.
    expect(source).toContain('onApprove: (proposalId: string) => void controller.handleApprovePending(proposalId)');
    expect(source).toContain('onApproveAll: () => void controller.handleApproveAll()');
    expect(source).not.toContain('<MeriActionConfirm');
    expect(source).not.toContain('<MeriBulkActionConfirm');
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
    const source = readMeri('MeriApprovalsTab.tsx');
    expect(source).toContain('if (!live) setConfirmFor(null);');
    expect(source).toContain('if (bulkOpen && proposedApprovals.length === 0) setBulkOpen(false);');
  });
});
