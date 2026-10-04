import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { assertSyntheticApprovedMemoryInTx } from './synthetic-approved-memory.helpers.js';
import {
  inspectCase12SetupTerminalRowInTx,
  type Case12SetupTerminalRowInput,
} from './case12-setup-terminal.read.js';

jest.mock('./synthetic-approved-memory.helpers.js', () => ({
  assertSyntheticApprovedMemoryInTx: jest.fn(),
}));

const guard = jest.mocked(assertSyntheticApprovedMemoryInTx);
const id = '11111111-1111-4111-8111-111111111111';
const proposer = '22222222-2222-4222-8222-222222222222';
const input: Case12SetupTerminalRowInput = {
  fixtureInstanceId: id,
  logicalId: 'MA510',
  candidateId: '11111111-1111-5111-8111-111111111111',
  itemId: id,
  clientId: id,
  proposerUserId: proposer,
  reviewerUserId: id,
  expectedCandidateRowVersion: '100',
  expectedItemRowVersion: '101',
  expectedPayload: {
    key: `meri-foundation-20260928:${id}:APPROVED-MA510`,
    clientId: id,
    scope: 'client',
  },
  admittedAt: '2026-10-04T10:00:00.000Z',
  deadlineAt: '2026-10-04T10:15:00.000Z',
};
const ctx = {
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  userId: proposer,
  role: 'standard_user',
} as TenantContext;
const tx = {} as Prisma.TransactionClient;
const authorization = {} as MemoryAuthorizationService;
const inspect = (value: unknown, context: unknown = ctx) =>
  inspectCase12SetupTerminalRowInTx(
    tx,
    context as TenantContext,
    value as Case12SetupTerminalRowInput,
    authorization,
  );

beforeEach(() => {
  guard.mockReset();
  guard.mockRejectedValue(new Error('native_guard_boundary'));
});

test('well-shaped locators still require the actual canonical guard', async () => {
  await expect(inspect(input)).rejects.toThrow('native_guard_boundary');
  expect(guard).toHaveBeenCalledTimes(1);
});

test.each([
  'fixtureInstanceId',
  'candidateId',
  'itemId',
  'clientId',
  'proposerUserId',
  'reviewerUserId',
  'logicalId',
  'admittedAt',
  'deadlineAt',
  'expectedCandidateRowVersion',
  'expectedItemRowVersion',
] as const)('rejects array coercion for %s before the native guard', async (key) => {
  await expect(inspect({ ...input, [key]: [input[key]] })).rejects.toThrow(
    'meri_case12_setup_terminal_not_verified',
  );
  expect(guard).not.toHaveBeenCalled();
});

test.each([null, [], {}, { ...input, expectedPayload: [] }, { ...input, expectedPayload: null }])(
  'rejects malformed terminal input before the native guard: %p',
  async (value) => {
    await expect(inspect(value)).rejects.toThrow('meri_case12_setup_terminal_not_verified');
    expect(guard).not.toHaveBeenCalled();
  },
);

test.each([
  { admittedAt: 'October 4, 2026' },
  { deadlineAt: input.admittedAt },
  { logicalId: 'MA510-DISTRACTOR-0000' },
  { logicalId: 'MA510-DISTRACTOR-0510' },
  { expectedCandidateRowVersion: 100 },
])('rejects invalid row or time bindings before the native guard: %p', async (change) => {
  await expect(inspect({ ...input, ...change })).rejects.toThrow(
    'meri_case12_setup_terminal_not_verified',
  );
  expect(guard).not.toHaveBeenCalled();
});

test('rejects a missing actor context before any native call', async () => {
  await expect(inspect(input, null)).rejects.toThrow('meri_case12_setup_terminal_not_verified');
  expect(guard).not.toHaveBeenCalled();
});
