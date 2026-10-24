import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { validate } from 'class-validator';
import {
  AdminSupportRequestsController,
  MySupportRequestsController,
} from './support-requests.controller.js';
import { CreateSupportRequestDto, ListSupportRequestsDto } from './support-requests.dto.js';
import { ROLES_KEY } from '../../auth/roles.decorator.js';

describe('Support request HTTP boundaries', () => {
  it('gates own requests at the lowest authenticated role and HQ at staff', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MySupportRequestsController)).toEqual([
      'client_portal_user',
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminSupportRequestsController)).toEqual([
      'capiro_admin',
    ]);
  });
  it('rejects injected ownership, malformed ids and oversized fields', async () => {
    const dto = Object.assign(new CreateSupportRequestDto(), {
      id: 'not-a-uuid',
      summary: 'x'.repeat(201),
      detail: 'x'.repeat(5001),
      runReference: 'x'.repeat(201),
      tenantId: 'forged',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property).sort()).toEqual([
      'detail',
      'id',
      'runReference',
      'summary',
      'tenantId',
    ]);
    expect(
      await validate(
        Object.assign(new ListSupportRequestsDto(), { tenantId: 'bad', cursor: 'bad' }),
      ),
    ).toHaveLength(2);
  });
  it('passes server caller context to every operation and keeps staff tenant selection explicit', async () => {
    const service = {
      create: jest.fn(),
      ownReceipt: jest.fn(),
      listForStaff: jest.fn(),
      detailForStaff: jest.fn(),
    };
    const own = new MySupportRequestsController(service as never);
    const staff = new AdminSupportRequestsController(service as never);
    const ctx = { tenantId: 'caller-tenant', userId: 'caller' } as never;
    const body = { id: 'request', summary: 'summary', detail: 'detail' };
    own.create(ctx, body);
    own.receipt(ctx, 'request');
    staff.list(ctx, { tenantId: 'target' });
    staff.detail(ctx, 'request', 'target');
    expect(service.create).toHaveBeenCalledWith(ctx, body);
    expect(service.ownReceipt).toHaveBeenCalledWith(ctx, 'request');
    expect(service.listForStaff).toHaveBeenCalledWith(ctx, { tenantId: 'target' });
    expect(service.detailForStaff).toHaveBeenCalledWith(ctx, 'target', 'request');
  });
});
