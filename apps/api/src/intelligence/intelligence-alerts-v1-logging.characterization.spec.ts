import { Logger } from '@nestjs/common';
import {
  clientId,
  clientRow,
  harness,
  installHooks,
  now,
  regulationRow,
  tenantId,
  trackedBill,
  until,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

function warningIo(h: ReturnType<typeof harness>, events: string[], failure?: Error) {
  const logger = (h.service as unknown as { logger: Logger }).logger;
  const warn = jest.fn(function (this: unknown, _message: unknown) {
    events.push('warn-call');
    if (failure) throw failure;
  });
  Object.defineProperty(logger, 'warn', {
    configurable: true,
    get: () => {
      events.push('warn-get');
      return warn;
    },
  });
  return { logger, warn };
}

it('hearing alert logging reads warn before the error message getter and retains the logger receiver', async () => {
  const events: string[] = [];
  const failure = new Error();
  Object.defineProperty(failure, 'message', {
    get: () => {
      events.push('message-get');
      return 'custom failure';
    },
  });
  const h = harness({
    rows: { 'port:tracked': { total: 1, bills: [trackedBill()] } },
    errors: { hearings: failure },
  });
  const { logger, warn } = warningIo(h, events);
  expect(await h.service.getHearingAlerts(clientId, tenantId, now, until)).toEqual([]);
  expect(events).toEqual(['warn-get', 'message-get', 'warn-call']);
  expect(warn).toHaveBeenCalledWith(`getHearingAlerts failed for ${clientId}: custom failure`);
  expect(warn.mock.contexts[0]).toBe(logger);
});

it('deadline emitter logging preserves warn lookup before rejected item message conversion', async () => {
  const events: string[] = [];
  const failure = new Error();
  Object.defineProperty(failure, 'message', {
    get: () => {
      events.push('message-get');
      return 'emit failure';
    },
  });
  const h = harness({
    rows: { clients: [clientRow()], documents: [regulationRow()] },
    errors: { changeUpsert: failure },
  });
  const { logger, warn } = warningIo(h, events);
  expect((await h.service.getCommentPeriodAlerts(tenantId)).alerts).toHaveLength(1);
  expect(events).toEqual(['warn-get', 'message-get', 'warn-call']);
  expect(warn.mock.contexts[0]).toBe(logger);
});

it('regulatory profile logging reads warn before String(reason) and keeps a surviving source', async () => {
  const events: string[] = [];
  const reason = {
    [Symbol.toPrimitive]: () => {
      events.push('reason-string');
      return 'custom reason';
    },
  };
  const h = harness({ errors: { 'port:links': reason } });
  const { logger, warn } = warningIo(h, events);
  expect((await h.service.getClientRegulatoryProfile(clientId, tenantId)).partial).toBe(true);
  expect(events).toEqual(['warn-get', 'reason-string', 'warn-call']);
  expect(warn).toHaveBeenCalledWith(
    `regulatory-profile source Tracked-bill regulations failed for client ${clientId}: custom reason`,
  );
  expect(warn.mock.contexts[0]).toBe(logger);
});

it('hearing alert logging failures remain observable instead of being converted to an empty alert result', async () => {
  const loggerFailure = new Error('logger failed');
  const h = harness({ errors: { 'port:tracked': new Error('tracked failed') } });
  warningIo(h, [], loggerFailure);
  await expect(h.service.getHearingAlerts(clientId, tenantId, now, until)).rejects.toBe(
    loggerFailure,
  );
});
