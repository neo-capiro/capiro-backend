import { OutreachV3DraftsController } from './outreach-v3-drafts.controller.js';

/**
 * Regression for the live 2026-08-24 "'This is good — approve' does nothing" bug.
 *
 * V3 author approval is EVENT-SOURCED: `POST :versionId/approval` appends a
 * `draft_version_approved` outreach event and deliberately never rewrites the
 * immutable `outreach_draft_versions` row. Confirmed in the live DB — every
 * version for the working campaign read `approval_status: 'not_required'`, while
 * engagement-api logs showed five successful (2xx, zero errors) approval POSTs.
 *
 * But `GET /drafts` returned `listForOutreach`, which reads that COLUMN. So the
 * UI checked `current.approvalStatus === 'approved'`, never saw it flip, and the
 * button appeared inert — a true silent no-op.
 *
 * Send was already correct: it resolves approval via
 * `approvals.getCurrentApproval` (event + exact-version re-verification). The
 * list now reads the same source, so the review surface agrees with the gate
 * that governs sending.
 */

type Artifact = {
  id: string;
  current: { id: string; version: number; approvalStatus: string } | null;
};

function makeController(opts: {
  artifacts: Artifact[];
  approvedVersionIds?: Set<string>;
  throwFor?: Set<string>;
}) {
  const calls: string[] = [];
  const drafts = {
    listForOutreach: jest.fn(async () => opts.artifacts),
  };
  const approvals = {
    getCurrentApproval: jest.fn(async (_ctx: unknown, _sid: string, versionId: string) => {
      calls.push(versionId);
      if (opts.throwFor?.has(versionId)) throw new Error('plan mismatch');
      return opts.approvedVersionIds?.has(versionId) ? { versionId } : null;
    }),
  };
  const controller = new OutreachV3DraftsController(
    approvals as never,
    drafts as never,
    {} as never,
  );
  return { controller, drafts, approvals, calls };
}

const CTX = { tenantId: 't1', userId: 'u1' } as never;
const SESSION = '3857d7ff-ef26-410e-8e5a-b7f062bcc001';

describe('GET /drafts — event-sourced approval overlay', () => {
  it('reports approved when an approval event exists, though the column says not_required', async () => {
    // Exactly the live shape: column never flipped, event was appended.
    const { controller } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-1', version: 1, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(['ver-1']),
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current!.approvalStatus).toBe('approved');
  });

  it('leaves a draft unapproved when no approval event exists', async () => {
    const { controller } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-1', version: 1, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(),
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current!.approvalStatus).toBe('not_required');
  });

  it('resolves each artifact independently', async () => {
    const { controller } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-1', version: 1, approvalStatus: 'not_required' } },
        { id: 'art-2', current: { id: 'ver-2', version: 1, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(['ver-2']),
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out.map((a) => a.current!.approvalStatus)).toEqual(['not_required', 'approved']);
  });

  it('does not treat a stale approval as approved (plan-aware resolution)', async () => {
    // getCurrentApproval returns null when the approval no longer matches the
    // current plan hash / artifact current version — editing or regenerating a
    // draft must drop it back to unapproved rather than stay green.
    const { controller } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-2', version: 2, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(['ver-1']), // only the OLD version was approved
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current!.approvalStatus).toBe('not_required');
  });

  it('never queries approval for an artifact with no current version', async () => {
    const { controller, approvals } = makeController({
      artifacts: [{ id: 'art-1', current: null }],
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current).toBeNull();
    expect(approvals.getCurrentApproval).not.toHaveBeenCalled();
  });

  it('skips the lookup when the column already says approved', async () => {
    const { controller, approvals } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-1', version: 1, approvalStatus: 'approved' } },
      ],
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current!.approvalStatus).toBe('approved');
    expect(approvals.getCurrentApproval).not.toHaveBeenCalled();
  });

  it('degrades to unapproved (never approved) if approval resolution throws', async () => {
    // Fail CLOSED: a resolution error must not present an unapproved draft as
    // approved, and must not take down the whole drafts list either.
    const { controller } = makeController({
      artifacts: [
        { id: 'art-1', current: { id: 'ver-1', version: 1, approvalStatus: 'not_required' } },
        { id: 'art-2', current: { id: 'ver-2', version: 1, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(['ver-2']),
      throwFor: new Set(['ver-1']),
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out[0]!.current!.approvalStatus).toBe('not_required');
    expect(out[1]!.current!.approvalStatus).toBe('approved');
  });

  it('preserves artifact order and identity', async () => {
    const { controller } = makeController({
      artifacts: [
        { id: 'art-a', current: { id: 'v-a', version: 1, approvalStatus: 'not_required' } },
        { id: 'art-b', current: { id: 'v-b', version: 1, approvalStatus: 'not_required' } },
        { id: 'art-c', current: { id: 'v-c', version: 1, approvalStatus: 'not_required' } },
      ],
      approvedVersionIds: new Set(['v-b']),
    });

    const out = (await controller.list(CTX, SESSION)) as Artifact[];

    expect(out.map((a) => a.id)).toEqual(['art-a', 'art-b', 'art-c']);
  });
});
