// Regression coverage for the comment-delete ACL gap found in the Workspace
// vNext stabilization audit: `remove()` previously had NO collaborator role
// check at all — any tenant member could delete any comment on any draft.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import { CommentsService } from './comments.service.js';

function makeMockPrisma(doc: { id: string; tenantId: string; draftId: string }, comment: Record<string, unknown>) {
  return {
    wsDocument: {
      findFirst: jest.fn(async () => doc),
    },
    wsComment: {
      findFirst: jest.fn(async () => comment),
      delete: jest.fn(async () => comment),
    },
  } as unknown as Record<string, unknown>;
}

describe('CommentsService.remove', () => {
  const doc = { id: 'doc-1', tenantId: 'tenant-1', draftId: 'draft-1' };
  let assertCan: jest.Mock;
  let generation: Record<string, unknown>;

  beforeEach(() => {
    assertCan = jest.fn(async () => 'reviewer');
    generation = {};
  });

  it("requires canReview to delete ANOTHER person's comment", async () => {
    const comment = { id: 'c-1', authorId: 'user-other', tenantId: 'tenant-1', documentId: 'doc-1' };
    const prisma = makeMockPrisma(doc, comment);
    const collaborators = { assertCan } as unknown as { assertCan: typeof assertCan };
    const service = new CommentsService(prisma as never, generation as never, collaborators as never);

    await service.remove('tenant-1', 'doc-1', 'c-1', 'user-1');

    expect(assertCan).toHaveBeenCalledWith(
      'tenant-1',
      'draft-1',
      'user-1',
      expect.any(Function),
      expect.stringContaining('reviewers'),
    );
    // The predicate passed must be canReview (owner/editor/reviewer), not canRead.
    const predicate = assertCan.mock.calls[0]![3] as (role: string | null) => boolean;
    expect(predicate('viewer')).toBe(false);
    expect(predicate('commenter')).toBe(false);
    expect(predicate('reviewer')).toBe(true);
  });

  it('rejects deleting another person\'s comment when the actor lacks canReview', async () => {
    const comment = { id: 'c-1', authorId: 'user-other', tenantId: 'tenant-1', documentId: 'doc-1' };
    const prisma = makeMockPrisma(doc, comment);
    const failingAssertCan = jest.fn(async () => {
      throw new ForbiddenException('nope');
    });
    const collaborators = { assertCan: failingAssertCan } as unknown as { assertCan: typeof failingAssertCan };
    const service = new CommentsService(prisma as never, generation as never, collaborators as never);

    await expect(service.remove('tenant-1', 'doc-1', 'c-1', 'user-1')).rejects.toThrow(ForbiddenException);
    expect((prisma as any).wsComment.delete).not.toHaveBeenCalled();
  });

  it('allows an author to delete their OWN comment without requiring canReview', async () => {
    const comment = { id: 'c-1', authorId: 'user-1', tenantId: 'tenant-1', documentId: 'doc-1' };
    const prisma = makeMockPrisma(doc, comment);
    const collaborators = { assertCan } as unknown as { assertCan: typeof assertCan };
    const service = new CommentsService(prisma as never, generation as never, collaborators as never);

    const result = await service.remove('tenant-1', 'doc-1', 'c-1', 'user-1');

    expect(result.deleted).toBe(true);
    expect((prisma as any).wsComment.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
    // Self-delete is still gated on canComment (must have access at all), not canReview.
    const predicate = assertCan.mock.calls[0]![3] as (role: string | null) => boolean;
    expect(predicate('viewer')).toBe(false);
    expect(predicate('commenter')).toBe(true);
  });
});
