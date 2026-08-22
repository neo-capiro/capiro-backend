import { NotFoundException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import { DefenseBudgetLifecycleController } from './defense-budget-lifecycle.controller.js';
import type { DefenseBudgetLifecycleReadService } from './defense-budget-lifecycle-read.service.js';

function serviceMock() {
  return {
    getCycleHealth: jest.fn(async (fy: number) => ({ fiscalYear: fy })),
    listExpectedSources: jest.fn(async () => []),
    getExpectedSourceDetail: jest.fn(async (id: string) => ({ id })),
    listReviewQueue: jest.fn(async () => []),
    listSignals: jest.fn(async () => []),
    getScheduleTickHealth: jest.fn(async () => ({})),
  } as unknown as DefenseBudgetLifecycleReadService;
}

describe('DefenseBudgetLifecycleController', () => {
  test('every handler is a GET-mapped method (no mutation route exists on this controller)', () => {
    const methods = Object.getOwnPropertyNames(DefenseBudgetLifecycleController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(
      [
        'cycleHealth',
        'expectedSources',
        'expectedSourceDetail',
        'reviewQueue',
        'signals',
        'scheduleTickHealth',
      ].sort(),
    );
  });

  test('cycleHealth delegates to the read service with the parsed fiscal year', async () => {
    const service = serviceMock();
    const controller = new DefenseBudgetLifecycleController(service);
    await controller.cycleHealth(2027);
    expect(service.getCycleHealth).toHaveBeenCalledWith(2027);
  });

  test('rejects a fiscal year outside the supported range instead of querying it', async () => {
    const service = serviceMock();
    const controller = new DefenseBudgetLifecycleController(service);
    await expect(controller.cycleHealth(1500)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.getCycleHealth).not.toHaveBeenCalled();
  });

  test('expectedSources forwards authorityTrack/expectedState query filters', async () => {
    const service = serviceMock();
    const controller = new DefenseBudgetLifecycleController(service);
    await controller.expectedSources(2027, 'appropriations', 'not_filed');
    expect(service.listExpectedSources).toHaveBeenCalledWith(2027, {
      authorityTrack: 'appropriations',
      expectedState: 'not_filed',
    });
  });

  test('expectedSourceDetail delegates by id with no fiscal-year gate', async () => {
    const service = serviceMock();
    const controller = new DefenseBudgetLifecycleController(service);
    await controller.expectedSourceDetail('es-1');
    expect(service.getExpectedSourceDetail).toHaveBeenCalledWith('es-1');
  });

  test('scheduleTickHealth takes no fiscal year and delegates directly', async () => {
    const service = serviceMock();
    const controller = new DefenseBudgetLifecycleController(service);
    await controller.scheduleTickHealth();
    expect(service.getScheduleTickHealth).toHaveBeenCalledWith();
  });
});
