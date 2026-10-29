import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { validateSync } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillController } from './client-profile-fill.controller.js';
import { researchStartRequest } from './client-profile-fill-start-request.js';
const ctx = { tenantId: randomUUID(), userId: randomUUID() } as TenantContext;
const clientId = randomUUID();
const input = { requestId: randomUUID(), sources: ['public_web' as const, 'lda' as const],
  attachmentIds: [randomUUID(), randomUUID()], ldaClientIds: [42, 73], website: 'https://research.example/' };

test('start identity is deterministic for equivalent selected sets', () => {
  const same = { ...input, sources: [...input.sources].reverse(),
    attachmentIds: [...input.attachmentIds].reverse(), ldaClientIds: [73, 42, 42] };
  expect(researchStartRequest(ctx, clientId, same)).toEqual(researchStartRequest(ctx, clientId, input));
});
test.each(['tenant', 'actor', 'client', 'sources', 'attachment', 'identity', 'website'] as const)(
  'the immutable command includes its %s selection', field => {
    const actor = { ...ctx }, command = structuredClone(input);
    let client = clientId;
    if (field === 'tenant') actor.tenantId = randomUUID();
    if (field === 'actor') actor.userId = randomUUID();
    if (field === 'client') client = randomUUID();
    if (field === 'sources') command.sources = ['lda'];
    if (field === 'attachment') command.attachmentIds = [randomUUID()];
    if (field === 'identity') command.ldaClientIds = [99];
    if (field === 'website') command.website = 'https://different.example/';
    expect(researchStartRequest(actor, client, command)!.sha256).not.toBe(researchStartRequest(ctx, clientId, input)!.sha256);
  },
);
test('public starts require a request UUID while internal legacy callers remain identifiable by server run ID', () => {
  const [, , Dto] = Reflect.getMetadata('design:paramtypes', ClientProfileFillController.prototype, 'start');
  expect(validateSync(Object.assign(new Dto(), { sources: ['lda'] })).some(error => error.property === 'requestId')).toBe(true);
  expect(validateSync(Object.assign(new Dto(), input))).toEqual([]);
  expect(() => researchStartRequest(ctx, clientId, { requestId: 'invalid' })).toThrow('Invalid research request ID');
  expect(researchStartRequest(ctx, clientId, {})).toBeUndefined();
});
