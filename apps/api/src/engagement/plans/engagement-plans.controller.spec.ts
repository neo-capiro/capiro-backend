import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ParseUUIDPipe,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { TenantContext } from '@capiro/shared';
import { ROLES_KEY } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import * as rules from './engagement-plan.rules.js';
import { EngagementPlansController } from './engagement-plans.controller.js';
import { EngagementPlansService } from './engagement-plans.service.js';

jest.mock('./engagement-plans.service.js', () => ({
  EngagementPlansService: class EngagementPlansService {},
}));

const ctx: TenantContext = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  tenantSlug: 'synthetic-tenant',
  userId: '20000000-0000-4000-8000-000000000001',
  clerkUserId: 'synthetic-clerk-user',
  role: 'standard_user',
};
const clientId = '30000000-0000-4000-8000-000000000001';
const planId = '40abcdef-0000-4000-8000-000000000001';
const waveId = '50abcdef-0000-4000-8000-000000000001';
const requestId = '60000000-0000-4000-8000-000000000001';
const receipt = { planId, clientId, version: 8 };
const serviceMethod = () => jest.fn((..._args: unknown[]) => receipt);
const serviceDouble = () => ({
  list: serviceMethod(),
  get: serviceMethod(),
  create: serviceMethod(),
  patch: serviceMethod(),
  createWave: serviceMethod(),
  patchWave: serviceMethod(),
  reorder: serviceMethod(),
  review: serviceMethod(),
  history: serviceMethod(),
});
let service: ReturnType<typeof serviceDouble>;
let controller: EngagementPlansController;
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

beforeEach(() => {
  service = serviceDouble();
  controller = new EngagementPlansController(service as unknown as EngagementPlansService);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Engagement manual plan controller boundary', () => {
  test('declares the canonical role guard, service injection and only manual routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EngagementPlansController)).toBe('engagement/plans');
    expect(Reflect.getMetadata(GUARDS_METADATA, EngagementPlansController)).toEqual([RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, EngagementPlansController)).toEqual(['standard_user']);
    expect(Reflect.getMetadata('design:paramtypes', EngagementPlansController)).toEqual([
      EngagementPlansService,
    ]);
    const expected = [
      ['list', RequestMethod.GET, '/'],
      ['get', RequestMethod.GET, ':planId'],
      ['create', RequestMethod.POST, '/'],
      ['patch', RequestMethod.PATCH, ':planId'],
      ['createWave', RequestMethod.POST, ':planId/waves'],
      ['patchWave', RequestMethod.PATCH, ':planId/waves/:waveId'],
      ['reorder', RequestMethod.POST, ':planId/waves/reorder'],
      ['review', RequestMethod.POST, ':planId/reviews'],
      ['history', RequestMethod.GET, ':planId/history'],
    ] as const;
    for (const [name, method, path] of expected) {
      const handler = EngagementPlansController.prototype[name];
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    }
    const routes = Object.getOwnPropertyNames(EngagementPlansController.prototype).filter(
      (name) => {
        const handler = Object.getOwnPropertyDescriptor(
          EngagementPlansController.prototype,
          name,
        )?.value;
        return (
          typeof handler === 'function' &&
          Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
        );
      },
    );
    expect(routes).toHaveLength(expected.length);
  });

  test('uses UUID pipes for every plan/wave path selector and canonical current-tenant injection', async () => {
    for (const method of [
      'list',
      'get',
      'create',
      'patch',
      'createWave',
      'patchWave',
      'reorder',
      'review',
      'history',
    ]) {
      const args = Object.values(
        Reflect.getMetadata(ROUTE_ARGS_METADATA, EngagementPlansController, method),
      ) as {
        index: number;
        data?: string;
        pipes?: unknown[];
        factory?: (...args: unknown[]) => unknown;
      }[];
      if (method !== 'list' && method !== 'create')
        expect(args.find((arg) => arg.data === 'planId')?.pipes).toEqual([ParseUUIDPipe]);
      const currentTenant = args.find((arg) => arg.index === 0)?.factory;
      expect(currentTenant).toEqual(expect.any(Function));
      expect(
        currentTenant?.(undefined, {
          switchToHttp: () => ({ getRequest: () => ({ tenantContext: ctx }) }),
        }),
      ).toBe(ctx);
      expect(() =>
        currentTenant?.(undefined, {
          switchToHttp: () => ({ getRequest: () => ({}) }),
        }),
      ).toThrow('TenantContext missing');
      if (method === 'patchWave')
        expect(args.find((arg) => arg.data === 'waveId')?.pipes).toEqual([ParseUUIDPipe]);
    }
    const pipe = new ParseUUIDPipe();
    await expect(pipe.transform(planId, { type: 'param' })).resolves.toBe(planId);
    await expect(pipe.transform('another-client', { type: 'param' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('forwards the exact trusted context and bounded list/history query normalization', () => {
    expect(controller.list(ctx, { clientId, limit: '3', cursor: 'next-page' })).toBe(receipt);
    expect(service.list).toHaveBeenCalledWith(ctx, { clientId, limit: 3, cursor: 'next-page' });
    expect(service.list.mock.calls[0]?.[0]).toBe(ctx);
    expect(controller.get(ctx, planId)).toBe(receipt);
    expect(service.get).toHaveBeenCalledWith(ctx, planId);
    expect(controller.history(ctx, planId, { beforeVersion: '8', limit: '2' })).toBe(receipt);
    expect(service.history).toHaveBeenCalledWith(ctx, planId, { beforeVersion: 8, limit: 2 });
  });

  test('normalizes create authoring without inventing client authority or losing the request identity', () => {
    expect(controller.create(ctx, { clientId, requestId, title: '  Manual plan  ' })).toBe(receipt);
    expect(service.create).toHaveBeenCalledWith(ctx, {
      clientId,
      requestId,
      title: 'Manual plan',
      officeReferences: [],
      objective: null,
    });
  });

  test('canonicalizes validated uppercase plan and wave selectors before forwarding', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const upperPlan = planId.toUpperCase();
    const upperWave = waveId.toUpperCase();
    controller.get(ctx, upperPlan);
    controller.patch(ctx, upperPlan, { expectedPlanVersion: 7, title: 'Plan' });
    controller.createWave(ctx, upperPlan, { requestId, expectedPlanVersion: 7, title: 'Wave' });
    controller.patchWave(ctx, upperPlan, upperWave, { expectedPlanVersion: 7, action: 'archive' });
    controller.reorder(ctx, upperPlan, { expectedPlanVersion: 7, waveIds: [upperWave] });
    controller.review(ctx, upperPlan, {
      expectedPlanVersion: 7,
      reviewDueAt: '2026-10-16T12:00:00Z',
    });
    controller.history(ctx, upperPlan, {});
    for (const name of [
      'get',
      'patch',
      'createWave',
      'patchWave',
      'reorder',
      'review',
      'history',
    ] as const)
      expect(service[name].mock.calls[0]?.[1]).toBe(planId);
    expect(service.patchWave.mock.calls[0]?.[2]).toBe(waveId);
    expect(service.reorder.mock.calls[0]?.[2]).toEqual({
      expectedPlanVersion: 7,
      waveIds: [waveId],
    });
  });

  test('preserves aggregate expected versions across plan and child commands', () => {
    controller.patch(ctx, planId, { expectedPlanVersion: 7, title: '  Revised plan ' });
    expect(service.patch).toHaveBeenCalledWith(ctx, planId, {
      expectedPlanVersion: 7,
      title: 'Revised plan',
    });
    controller.createWave(ctx, planId, {
      requestId,
      expectedPlanVersion: 7,
      title: '  Discovery ',
    });
    expect(service.createWave).toHaveBeenCalledWith(ctx, planId, {
      requestId,
      expectedPlanVersion: 7,
      title: 'Discovery',
      formatLabel: null,
      window: null,
      officeTargetIds: [],
    });
    controller.patchWave(ctx, planId, waveId, { expectedPlanVersion: 7, action: 'archive' });
    expect(service.patchWave).toHaveBeenCalledWith(ctx, planId, waveId, {
      expectedPlanVersion: 7,
      action: 'archive',
    });
    controller.reorder(ctx, planId, { expectedPlanVersion: 7, waveIds: [waveId] });
    expect(service.reorder).toHaveBeenCalledWith(ctx, planId, {
      expectedPlanVersion: 7,
      waveIds: [waveId],
    });
  });

  test('uses current server time for explicit future review validation and canonicalizes the deadline', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-15T12:00:00Z'));
    controller.review(ctx, planId, {
      expectedPlanVersion: 7,
      reviewDueAt: '2026-10-15T10:00:01-04:00',
    });
    expect(service.review).toHaveBeenCalledWith(ctx, planId, {
      expectedPlanVersion: 7,
      reviewDueAt: '2026-10-15T14:00:01.000Z',
    });
    expect(() =>
      controller.review(ctx, planId, {
        expectedPlanVersion: 7,
        reviewDueAt: '2026-10-15T12:00:00Z',
      }),
    ).toThrow(BadRequestException);
    expect(service.review).toHaveBeenCalledTimes(1);
  });

  test('rejects unknown authority, rescope and wave execution fields before invoking the service', () => {
    const invalid = [
      () => controller.list(ctx, { tenantId: ctx.tenantId }),
      () => controller.history(ctx, planId, { beforeVersion: '-1' }),
      () =>
        controller.create(ctx, { clientId, requestId, title: 'Manual', ownerUserId: ctx.userId }),
      () => controller.patch(ctx, planId, { expectedPlanVersion: 7, clientId }),
      () =>
        controller.createWave(ctx, planId, {
          requestId,
          expectedPlanVersion: 7,
          title: 'Wave',
          status: 'sent',
        }),
      () => controller.patchWave(ctx, planId, waveId, { expectedPlanVersion: 7, planId }),
      () => controller.reorder(ctx, planId, { expectedPlanVersion: '7', waveIds: [waveId] }),
      () => controller.review(ctx, planId, { expectedPlanVersion: 7 }),
    ];
    for (const call of invalid) {
      try {
        call();
        throw new Error('Expected input rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'PLAN_INPUT_INVALID',
          message: expect.any(String),
        });
      }
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  test('maps only typed rule failures and preserves unrelated normalization/service errors', () => {
    jest.spyOn(rules, 'normalizeListQuery').mockImplementationOnce(() => {
      throw new rules.PlanRuleError('Synthetic lifecycle conflict');
    });
    try {
      controller.list(ctx, {});
      throw new Error('Expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'PLAN_INVALID_LIFECYCLE',
        message: 'Synthetic lifecycle conflict',
      });
    }
    const unexpected = new Error('Unexpected normalizer failure');
    jest.spyOn(rules, 'normalizeListQuery').mockImplementationOnce(() => {
      throw unexpected;
    });
    expect(thrownBy(() => controller.list(ctx, {}))).toBe(unexpected);
    const dependency = new Error('Service dependency failed');
    service.get.mockImplementationOnce(() => {
      throw dependency;
    });
    expect(thrownBy(() => controller.get(ctx, planId))).toBe(dependency);
  });
});
