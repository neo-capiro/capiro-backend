import { Reflector } from '@nestjs/core';
import { ProcurementLineController } from './procurement-line.controller.js';
import { ROLES_KEY } from '../../auth/roles.decorator.js';

describe('ProcurementLineController', () => {
  const makeController = () => {
    const reads = { getLine: jest.fn(), search: jest.fn() };
    const controller = new ProcurementLineController(reads as never);
    return { controller, reads };
  };

  test('GET /defense-budget/procurement-lines delegates search + limit verbatim', async () => {
    const { controller, reads } = makeController();
    reads.search.mockResolvedValue({ items: [] });
    await controller.search('warrior', '10');
    expect(reads.search).toHaveBeenCalledWith('warrior', '10');
  });

  test('GET /defense-budget/procurement-lines/:appropriationCode/:lineItemNumber delegates the raw params', async () => {
    const { controller, reads } = makeController();
    reads.getLine.mockResolvedValue({ line: {} });
    await controller.getLine('0300D', '0204WARSYS');
    expect(reads.getLine).toHaveBeenCalledWith('0300D', '0204WARSYS');
  });

  test('is a standard_user read surface (no admin-only or write handlers)', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ProcurementLineController)).toEqual(['standard_user']);
    const proto = ProcurementLineController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual(['getLine', 'search']);
    for (const name of handlers) {
      expect(Reflect.getMetadata('method', proto[name] as object)).toBe(0); // RequestMethod.GET
    }
  });
});
