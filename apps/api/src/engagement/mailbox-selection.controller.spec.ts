import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { EngagementController } from './engagement.controller.js';
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'synthetic-actor',
  role: 'standard_user' as const,
};
const B = '44444444-4444-4444-8444-444444444444';
const input = {
  to: [{ email: 'recipient@example.test' }],
  subject: 'Synthetic only',
  bodyHtml: '<p>Hello</p>',
};
describe('mailbox picker route and send DTO', () => {
  it('exposes a read route through the existing protected controller', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EngagementController.prototype.mailboxes)).toBe(
      'mail/mailboxes',
    );
    expect(Reflect.getMetadata(ROLES_KEY, EngagementController)).toEqual(['standard_user']);
  });
  const dto = Reflect.getMetadata(
    'design:paramtypes',
    EngagementController.prototype,
    'sendSingleMail',
  )[1];
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('accepts and forwards a UUID selector through the production DTO and controller', async () => {
    const body = await pipe.transform(
      { ...input, senderConnectionId: B },
      { type: 'body', metatype: dto },
    );
    const sendSingleMail = jest.fn();
    const controller = new EngagementController(
      { sendSingleMail } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    controller.sendSingleMail(ctx, body);
    expect(sendSingleMail).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ senderConnectionId: B }),
    );
  });
  it.each(['not-an-id', '', null, 7])(
    'rejects malformed mailbox selector %s',
    async (senderConnectionId) => {
      await expect(
        pipe.transform({ ...input, senderConnectionId }, { type: 'body', metatype: dto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
  it('retains the legacy recipient object and optional sender omission', async () => {
    const body = await pipe.transform(
      { ...input, to: input.to[0] },
      { type: 'body', metatype: dto },
    );
    expect(body.to).toEqual(input.to);
    expect(body.senderConnectionId).toBeUndefined();
  });
});
