import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { parsePersonCreateCommand, personCreateDigest } from './client-people-command.js';
const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;
const client = '00000000-0000-4000-8000-000000000003';
const requestId = '00000000-0000-4000-8000-000000000004';
it('normalizes the actual create fields and binds every field and principal in the digest', () => {
  const input = parsePersonCreateCommand({
    requestId,
    name: '  Synthetic person  ',
    title: '',
    email: null,
    phone: '',
    role: '',
    notes: '',
  });
  expect(input.lastContact).toBeNull();
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        'client-person-create',
        1,
        ctx.tenantId,
        ctx.userId,
        client,
        requestId,
        'Synthetic person',
        '',
        null,
        '',
        '',
        '',
        null,
      ]),
    )
    .digest('hex');
  expect(personCreateDigest(ctx, client, input)).toBe(expected);
  for (const field of [
    'name',
    'title',
    'email',
    'phone',
    'role',
    'notes',
    'lastContact',
    'requestId',
  ] as const)
    expect(personCreateDigest(ctx, client, { ...input, [field]: 'changed' })).not.toBe(expected);
  expect(personCreateDigest({ ...ctx, userId: client }, client, input)).not.toBe(expected);
  expect(personCreateDigest({ ...ctx, tenantId: client }, client, input)).not.toBe(expected);
  expect(personCreateDigest(ctx, requestId, input)).not.toBe(expected);
});
it.each([
  { name: 'Name' },
  { requestId, name: ' ' },
  { requestId, name: 'Name', email: 'invalid' },
  { requestId, name: 'Name', notes: 'a'.repeat(20001) },
  { requestId, name: 'Name', id: client },
  { requestId, name: 'Name', lastContact: 'not-a-date' },
])('rejects malformed manual commands before dispatching a transaction', (input) => {
  expect(() => parsePersonCreateCommand(input)).toThrow();
});
