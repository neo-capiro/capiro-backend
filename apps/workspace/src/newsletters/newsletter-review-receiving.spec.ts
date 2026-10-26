import {
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  parseNewsletterComments,
  parseNewsletterReview,
  type NewsletterReview,
  type NewsletterReviewComment,
} from '@capiro/shared/newsletter';
import { NewsletterService } from './newsletter.service.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const documentId = id(1);
const expected = { documentId };
const time = '2026-10-26T00:00:00.000Z';
const ctx = { tenantId: id(2), clerkUserId: 'user_synthetic_reader' };
const comment = (): NewsletterReviewComment => ({
  id: id(3),
  tenantId: ctx.tenantId,
  documentId,
  campaignId: documentId,
  authorId: 'user_synthetic_author',
  authorName: 'Team member',
  blockId: null,
  parentId: null,
  message: 'Saved comment',
  resolved: false,
  createdAt: time,
});
const review = (): NewsletterReview => ({
  id: documentId,
  name: 'Saved review',
  role: 'viewer',
  html: '<p>Saved content</p>',
  comments: [comment()],
});
function accepted<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function refusedComment(value: unknown): void {
  expect(parseNewsletterComments({ items: [value] }, expected).ok).toBe(false);
  expect(parseNewsletterReview({ ...review(), comments: [value] }, expected).ok).toBe(false);
}

it.each(['owner', 'editor', 'commenter', 'viewer'] as const)(
  'receives actual service review/comments for the %s role without an editable campaign',
  async (role) => {
    const persisted = comment();
    const { campaignId: _campaignId, authorName: _authorName, ...stored } = persisted;
    const document = {
      id: documentId,
      tenantId: ctx.tenantId,
      ownerId: role === 'owner' ? ctx.clerkUserId : 'user_synthetic_owner',
      name: 'Saved review',
      revision: 7,
      status: 'draft',
      updatedAt: new Date(time),
      design: governmentAffairsNewsletter(),
      config: defaultNewsletterConfig(),
    };
    const comments = { findMany: jest.fn(async () => [{ ...stored, createdAt: new Date(time) }]) };
    const service = new NewsletterService(
      {
        wsNewsletterDocument: { findFirst: jest.fn(async () => document) },
        wsNewsletterReviewer: { findFirst: jest.fn(async () => ({ role })) },
        wsNewsletterComment: comments,
      } as never,
      {
        newsletterMember: jest.fn(async () => true),
        userDisplays: jest.fn(async () => new Map()),
      } as never,
      {} as never,
      { get: jest.fn() } as never,
    );
    const result = accepted(parseNewsletterReview(await service.review(ctx, documentId), expected));
    expect(result).toMatchObject({
      id: documentId,
      name: document.name,
      role,
      comments: [persisted],
    });
    expect(result.html).toContain('<');
    expect(Object.keys(result).sort()).toEqual(['comments', 'html', 'id', 'name', 'role']);
    expect(
      accepted(parseNewsletterComments(await service.comments(ctx, documentId), expected)),
    ).toEqual({ items: result.comments });
    expect(comments.findMany).toHaveBeenLastCalledWith({
      where: { tenantId: ctx.tenantId, documentId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  },
);

it('preserves nullable anchors, unlisted thread parents and inert HTML in a deep copied read', () => {
  const source = review();
  source.html = '<img src=x onerror="danger()"><script>danger()</script>';
  source.comments.push({
    ...comment(),
    id: id(4),
    parentId: id(99),
    blockId: 'block-not-in-this-read',
    resolved: true,
  });
  const result = accepted(parseNewsletterReview(source, { documentId: documentId.toUpperCase() }));
  expect(result).toEqual(source);
  expect(result).not.toBe(source);
  expect(result.comments).not.toBe(source.comments);
  expect(result.comments[0]).not.toBe(source.comments[0]);
  source.comments[0]!.message = 'Changed after receiving';
  expect(result.comments[0]!.message).toBe('Saved comment');
  expect(result.comments[0]!.blockId).toBeNull();
  expect(result.comments[0]!.parentId).toBeNull();
  expect(result.comments[1]!.parentId).toBe(id(99));
});

it('binds each comment documentId and campaignId in both reads, including mixed-document collections', () => {
  for (const key of ['documentId', 'campaignId']) {
    const foreign = { ...comment(), id: id(4), [key]: id(99) };
    const comments = parseNewsletterComments({ items: [comment(), foreign] }, expected);
    const opened = parseNewsletterReview({ ...review(), comments: [comment(), foreign] }, expected);
    expect(comments).toEqual({
      ok: false,
      error: { code: 'identity_mismatch', path: `$.items.1.${key}` },
    });
    expect(opened).toEqual({
      ok: false,
      error: { code: 'identity_mismatch', path: `$.comments.1.${key}` },
    });
  }
  expect(parseNewsletterReview({ ...review(), id: id(99), comments: [] }, expected)).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.id' },
  });
});

it('requires a valid closed document binding even for an empty collection', () => {
  for (const binding of [
    undefined,
    null,
    {},
    { documentId: null },
    { documentId: 'bad' },
    { documentId, revision: 1 },
    { documentId, clientId: id(99) },
  ]) {
    expect(parseNewsletterComments({ items: [] }, binding as never).ok).toBe(false);
    expect(parseNewsletterReview({ ...review(), comments: [] }, binding as never).ok).toBe(false);
  }
  // @ts-expect-error Review reads require the requested document, not optional correlation.
  expect(parseNewsletterReview(review()).ok).toBe(false);
  // @ts-expect-error Empty comment reads still require a document binding.
  expect(parseNewsletterComments({ items: [] }).ok).toBe(false);
});

it('accepts zero through 500 rows without inventing completeness or sorting, and refuses 501', () => {
  const items = Array.from({ length: 500 }, (_, n) => ({ ...comment(), id: id(n + 10) }));
  items[0]!.createdAt = '2026-10-26T00:01:00.000Z';
  for (const rows of [[], items]) {
    expect(accepted(parseNewsletterComments({ items: rows }, expected))).toEqual({ items: rows });
    expect(
      accepted(parseNewsletterReview({ ...review(), comments: rows }, expected)).comments,
    ).toEqual(rows);
  }
  const tooMany = [...items, comment()];
  expect(parseNewsletterComments({ items: tooMany }, expected)).toEqual({
    ok: false,
    error: { code: 'limit_exceeded', path: '$.items' },
  });
  expect(parseNewsletterReview({ ...review(), comments: tooMany }, expected)).toEqual({
    ok: false,
    error: { code: 'limit_exceeded', path: '$.comments' },
  });
});

it('requires every actual comment field and rejects malformed types and source-bound limits', () => {
  for (const key of Object.keys(comment())) {
    const missing: Record<string, unknown> = { ...comment() };
    delete missing[key];
    refusedComment(missing);
    if (key !== 'blockId' && key !== 'parentId') refusedComment({ ...comment(), [key]: null });
  }
  for (const invalid of [
    { id: 'bad' },
    { tenantId: 'bad' },
    { documentId: 'bad' },
    { campaignId: 'bad' },
    { authorId: 1 },
    { authorName: false },
    { blockId: 1 },
    { blockId: 'b'.repeat(101) },
    { parentId: 'bad' },
    { message: ' ' },
    { message: 'm'.repeat(10001) },
    { resolved: 'false' },
    { createdAt: new Date(time) },
    { createdAt: '2026-10-26' },
  ])
    refusedComment({ ...comment(), ...invalid });
  expect(
    accepted(
      parseNewsletterComments(
        { items: [{ ...comment(), message: 'm'.repeat(10000), blockId: 'b'.repeat(100) }] },
        expected,
      ),
    ).items,
  ).toHaveLength(1);
});

it('requires exact review fields and role vocabulary without normalizing content', () => {
  for (const key of Object.keys(review())) {
    const missing: Record<string, unknown> = { ...review() };
    delete missing[key];
    expect(parseNewsletterReview(missing, expected).ok).toBe(false);
    expect(parseNewsletterReview({ ...review(), [key]: null }, expected).ok).toBe(false);
  }
  for (const invalid of [
    { name: ' ' },
    { name: 'n'.repeat(201) },
    { role: 'admin' },
    { role: 'approver' },
    { role: 'Owner' },
    { html: {} },
    { comments: {} },
  ])
    expect(parseNewsletterReview({ ...review(), ...invalid }, expected).ok).toBe(false);
  const source = { ...review(), name: 'n'.repeat(200), html: '' };
  source.comments[0]!.message = '  Retain wire spacing  ';
  expect(accepted(parseNewsletterReview(source, expected))).toEqual(source);
});

it('rejects fabricated editable, permission, receipt, delivery and completeness fields', () => {
  for (const extra of [
    { revision: 2 },
    { design: {} },
    { config: {} },
    { clientId: id(9) },
    { canEdit: true },
    { requestId: id(9) },
    { delivered: true },
  ]) {
    expect(parseNewsletterReview({ ...review(), ...extra }, expected).ok).toBe(false);
    refusedComment({ ...comment(), ...extra });
  }
  for (const extra of [{ cursor: null }, { hasMore: false }, { complete: true }])
    expect(parseNewsletterComments({ items: [], ...extra }, expected).ok).toBe(false);
  for (const bad of [null, undefined, [], {}, { items: null }, { items: {} }])
    expect(parseNewsletterComments(bad, expected).ok).toBe(false);
});

it('rejects accessors, cycles, undefined and non-JSON values without invoking their code', () => {
  const getter = jest.fn(() => documentId);
  const binding = Object.defineProperty({}, 'documentId', { enumerable: true, get: getter });
  expect(parseNewsletterReview(review(), binding as never).ok).toBe(false);
  expect(parseNewsletterComments({ items: [] }, binding as never).ok).toBe(false);
  const accessor = Object.defineProperty(comment(), 'message', { enumerable: true, get: getter });
  refusedComment(accessor);
  expect(getter).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = { ...comment() };
  cycle.message = cycle;
  for (const value of [
    cycle,
    { ...comment(), message: undefined },
    { ...comment(), message: () => 'text' },
  ])
    refusedComment(value);
});
