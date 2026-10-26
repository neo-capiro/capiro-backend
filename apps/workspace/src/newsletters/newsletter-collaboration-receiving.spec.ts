import {
  parseNewsletterReviewerTeam,
  parseNewsletterInvitationResult,
  parseNewsletterThreadNotifications,
  parseNewsletterAccountInvitationReceipt,
  parseNewsletterComments,
  type NewsletterReviewerTeam,
  type NewsletterAccountInvitationStatus,
  type NewsletterReceiveResult,
} from '@capiro/shared/newsletter';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const actor = 'user_synthetic_owner';
const email = 'reviewer@example.test';
const expected = { currentUserId: actor };
const team = (): NewsletterReviewerTeam => ({
  role: 'owner',
  currentUserId: actor,
  items: [
    { userId: actor, name: 'Newsletter owner', email: '', role: 'owner', notifications: 'all' },
  ],
  available: [{ clerkUserId: 'user_synthetic_reviewer', name: 'Reviewer', email }],
  pending: [
    {
      id: id(1),
      email,
      role: 'commenter',
      accountRole: 'member',
      message: '',
      expiresAt: '2026-11-25T12:00:00.000Z',
    },
  ],
  invitationEmailAvailable: false,
  canInviteAccounts: false,
});
function accepted<T>(result: NewsletterReceiveResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

it('receives owner and admitted lower-role team shapes without treating availability as delivery', () => {
  const original = team();
  const result = accepted(parseNewsletterReviewerTeam(original, expected));
  expect(result).toEqual(original);
  expect(result).not.toBe(original);
  original.items[0]!.name = 'Changed after receiving';
  expect(result.items[0]!.name).toBe('Newsletter owner');
  for (const role of ['editor', 'commenter', 'viewer'] as const) {
    const value = { ...team(), role, available: [], pending: [] };
    expect(accepted(parseNewsletterReviewerTeam(value, expected))).toEqual(value);
  }
  expect(result.invitationEmailAvailable).toBe(false);
  expect('delivered' in result).toBe(false);
});

it('rejects a coherent foreign actor and missing, malformed or self-invented bindings', () => {
  expect(parseNewsletterReviewerTeam(team(), { currentUserId: 'user_other' })).toMatchObject({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.currentUserId' },
  });
  for (const binding of [undefined, {}, { currentUserId: '' }, { ...expected, documentId: id(2) }])
    expect(parseNewsletterReviewerTeam(team(), binding as typeof expected).ok).toBe(false);
  const foreign = { ...team(), currentUserId: 'user_other', items: [] };
  expect(parseNewsletterReviewerTeam(foreign, expected).ok).toBe(false);
});

it('enforces loaded collection boundaries and actual nested fields without adding completeness', () => {
  const value = team();
  value.items = Array.from({ length: 501 }, (_, i) => ({
    ...value.items[0]!,
    userId: `user_${i}`,
  }));
  value.available = Array.from({ length: 500 }, (_, i) => ({
    clerkUserId: `user_${i}`,
    name: '',
    email,
  }));
  value.pending = Array.from({ length: 50 }, (_, i) => ({ ...team().pending[0]!, id: id(i + 1) }));
  expect(parseNewsletterReviewerTeam(value, expected).ok).toBe(true);
  for (const field of ['items', 'available', 'pending'] as const) {
    const invalid = { ...value, [field]: [...value[field], value[field][0]] };
    expect(parseNewsletterReviewerTeam(invalid, expected)).toMatchObject({
      ok: false,
      error: { code: 'limit_exceeded' },
    });
  }
  for (const patch of [
    { role: 'approver' },
    { notifications: 'sent' },
    { userId: null },
    { delivered: true },
  ]) {
    expect(
      parseNewsletterReviewerTeam(
        { ...team(), items: [{ ...team().items[0], ...patch }] },
        expected,
      ).ok,
    ).toBe(false);
  }
  for (const patch of [
    { expiresAt: 'tomorrow' },
    { accountRole: 'owner' },
    { message: 'a'.repeat(2001) },
  ])
    expect(
      parseNewsletterReviewerTeam(
        { ...team(), pending: [{ ...team().pending[0], ...patch }] },
        expected,
      ).ok,
    ).toBe(false);
  expect(parseNewsletterReviewerTeam({ ...team(), total: 1 }, expected).ok).toBe(false);
});

it('receives saved invitation states and binds the normalized original address, not a request receipt', () => {
  const binding = { ...expected, email: ' Reviewer@EXAMPLE.test ' };
  for (const status of ['pending', 'ready', 'cancelled'] as const) {
    const value = { ...team(), invitation: { id: id(3), email, status } };
    expect(accepted(parseNewsletterInvitationResult(value, binding))).toEqual(value);
    expect(
      parseNewsletterInvitationResult(value, { ...binding, email: 'other@example.test' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'identity_mismatch', path: '$.invitation.email' },
    });
  }
  const value = { ...team(), invitation: { id: id(3), email, status: 'ready' } };
  expect(
    parseNewsletterInvitationResult(
      { ...value, invitation: { ...value.invitation, status: 'delivered' } },
      binding,
    ).ok,
  ).toBe(false);
  expect(
    parseNewsletterInvitationResult(
      { ...value, invitation: { ...value.invitation, requestKey: id(4) } },
      binding,
    ).ok,
  ).toBe(false);
  expect(
    parseNewsletterInvitationResult(value, { ...binding, currentUserId: 'user_other' }).ok,
  ).toBe(false);
  expect(parseNewsletterReviewerTeam(value, expected).ok).toBe(false);
});

it('receives default, canonical-root and empty watcher choices without inventing a reply echo', () => {
  const value = {
    rootId: null,
    userIds: [actor],
    items: [],
    editable: false,
    emailAvailable: false,
  };
  // The service default can name the actor even when the eligible set is empty.
  expect(accepted(parseNewsletterThreadNotifications(value))).toEqual(value);
  const root = {
    ...value,
    rootId: id(5),
    userIds: [],
    editable: true,
    items: [{ userId: actor, name: '<b>Owner</b>', email: '' }],
  };
  expect(accepted(parseNewsletterThreadNotifications(root))).toEqual(root);
  expect(parseNewsletterThreadNotifications({ ...root, documentId: id(6) }).ok).toBe(false);
  expect(parseNewsletterThreadNotifications({ ...root, userIds: Array(101).fill(actor) }).ok).toBe(
    false,
  );
  expect(
    parseNewsletterThreadNotifications({ ...root, items: [{ ...root.items[0], delivered: true }] })
      .ok,
  ).toBe(false);
  expect(parseNewsletterThreadNotifications({ ...root, emailAvailable: 'true' }).ok).toBe(false);
});

it('preserves every actual account status and the server retry flag, with mandatory saved-ID binding', () => {
  const statuses: NewsletterAccountInvitationStatus[] = [
    'checking',
    'sending',
    'invited',
    'reused',
    'member_ready',
    'role_conflict',
    'admin_required',
    'waiting',
    'expired',
    'revoked',
    'cancelled',
    'failed',
    'outcome_unknown',
  ];
  for (const status of statuses) {
    const value = {
      id: id(7),
      status,
      accountRole: 'member',
      message: 'Check current status.',
      canRetry: false,
    };
    expect(
      accepted(
        parseNewsletterAccountInvitationReceipt(value, { invitationId: id(7).toUpperCase() }),
      ),
    ).toEqual(value);
  }
  const value = { id: id(7), status: 'failed', accountRole: 'admin', message: '', canRetry: true };
  expect(
    accepted(parseNewsletterAccountInvitationReceipt(value, { invitationId: id(7) })).canRetry,
  ).toBe(true);
  expect(parseNewsletterAccountInvitationReceipt(value, { invitationId: id(8) })).toMatchObject({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.id' },
  });
  for (const patch of [
    { status: 'delivered' },
    { providerInvitationId: 'private' },
    { errorCode: 'private' },
    { canRetry: 'true' },
  ])
    expect(
      parseNewsletterAccountInvitationReceipt({ ...value, ...patch }, { invitationId: id(7) }).ok,
    ).toBe(false);
  expect(parseNewsletterAccountInvitationReceipt(value, undefined as never).ok).toBe(false);
});

it('never invokes hostile getters and rejects non-JSON values through the existing snapshot owner', () => {
  const getter = jest.fn(() => actor);
  const hostile = Object.defineProperty(team(), 'currentUserId', { enumerable: true, get: getter });
  expect(parseNewsletterReviewerTeam(hostile, expected)).toMatchObject({
    ok: false,
    error: { code: 'invalid_json' },
  });
  const binding = Object.defineProperty({}, 'currentUserId', { enumerable: true, get: getter });
  expect(parseNewsletterReviewerTeam(team(), binding as typeof expected).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  const cyclic: Record<string, unknown> = { ...team() };
  cyclic.self = cyclic;
  for (const value of [
    cyclic,
    { ...team(), pending: [new Date()] },
    { ...team(), extra: undefined },
  ])
    expect(parseNewsletterReviewerTeam(value, expected).ok).toBe(false);
});

it('keeps the existing comments receiver and its non-receipt contract intact', () => {
  expect(accepted(parseNewsletterComments({ items: [] }, { documentId: id(9) }))).toEqual({
    items: [],
  });
  expect(parseNewsletterComments({ items: [], acknowledged: true }, { documentId: id(9) }).ok).toBe(
    false,
  );
  // Public types do not invent a document echo, mail result or mutation recovery proof.
  const value = accepted(parseNewsletterReviewerTeam(team(), expected));
  // @ts-expect-error Team does not echo the requested document.
  const documentId: string = value.documentId;
  // @ts-expect-error Availability is not a delivery receipt.
  const delivered: boolean = value.delivered;
  expect([documentId, delivered]).toEqual([undefined, undefined]);
});
