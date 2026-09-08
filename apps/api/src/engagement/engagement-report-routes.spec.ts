import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { EngagementController } from './engagement.controller.js';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const clientId = '11111111-1111-4111-8111-111111111111';
const bodyFor = (method: string, body: unknown, index = 1) => pipe.transform(body, {
  type: 'body', metatype: Reflect.getMetadata('design:paramtypes', EngagementController.prototype, method)[index],
});

describe('Reports request contracts', () => {
  test('create requires a client and explicit cycle while allowing canonical defaults and deliberate blank edits', async () => {
    const valid = { clientId, reportYear: 2025, directoryContactId: 'member-123', building: '' };
    await expect(bodyFor('createReportTargetOffice', valid)).resolves.toMatchObject(valid);
    await expect(bodyFor('createReportTargetOffice', { ...valid, clientId: null })).rejects.toThrow();
    await expect(bodyFor('createReportTargetOffice', { ...valid, reportYear: undefined })).rejects.toThrow();
    await expect(bodyFor('createReportTargetOffice', { ...valid, reportYear: null })).rejects.toThrow();
  });

  test('restore requires one status field and year; row-wide implicit reset is rejected', async () => {
    const valid = { clientId, officeKey: 'directory:member-123', reportYear: 2025, field: 'prepStatus' };
    await expect(bodyFor('clearReportTargetOfficeOverrides', valid)).resolves.toMatchObject(valid);
    await expect(bodyFor('clearReportTargetOfficeOverrides', { ...valid, field: undefined })).rejects.toThrow();
    await expect(bodyFor('clearReportTargetOfficeOverrides', { ...valid, field: 'all' })).rejects.toThrow();
    await expect(bodyFor('clearReportTargetOfficeOverrides', { ...valid, reportYear: undefined })).rejects.toThrow();
  });

  test('editing display metadata cannot rekey a saved target', async () => {
    await expect(bodyFor('updateReportTargetOffice', { memberPrincipal: 'Edited name', building: null }, 2)).resolves.toMatchObject({ memberPrincipal: 'Edited name', building: null });
    await expect(bodyFor('updateReportTargetOffice', { officeKey: 'directory:different-person' }, 2)).rejects.toThrow();
    await expect(bodyFor('updateReportTargetOffice', { directoryContactId: 'different-person' }, 2)).rejects.toThrow();
  });
});
