import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { InternalQualityTelemetryController } from './internal-quality-telemetry.controller.js';
import type { QualityTelemetryCaptureService } from './quality-telemetry-capture.service.js';

function controllerWith(recordEventImpl?: jest.Mock) {
  const recordEvent = recordEventImpl ?? jest.fn(async () => ({ status: 'recorded', id: 'event-1' }));
  const capture = { recordEvent } as unknown as QualityTelemetryCaptureService;
  return { controller: new InternalQualityTelemetryController(capture), recordEvent };
}

const VALID_BODY = {
  tenantId: 'tenant-1',
  surface: 'workspace',
  operation: 'workspace.doc_version.generate',
  eventType: 'generated',
  artifactType: 'workspace_doc_version',
  artifactId: 'doc-1',
  observedAt: '2026-08-21T00:00:00.000Z',
};

describe('InternalQualityTelemetryController', () => {
  it('delegates a well-formed body to QualityTelemetryCaptureService.recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    const result = await controller.recordEvent({ ...VALID_BODY });
    expect(result).toEqual({ status: 'recorded', id: 'event-1' });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const input = recordEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.tenantId).toBe('tenant-1');
    expect(input.surface).toBe('workspace');
    expect(input.eventType).toBe('generated');
  });

  it('rejects a missing tenantId before calling recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    await expect(controller.recordEvent({ ...VALID_BODY, tenantId: undefined })).rejects.toThrow(BadRequestException);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects a surface outside the closed vocabulary before calling recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    await expect(controller.recordEvent({ ...VALID_BODY, surface: 'not-a-real-surface' })).rejects.toThrow(
      BadRequestException,
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects an eventType outside the closed vocabulary before calling recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    await expect(controller.recordEvent({ ...VALID_BODY, eventType: 'not-a-real-event' })).rejects.toThrow(
      BadRequestException,
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects an artifactType outside the closed vocabulary before calling recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    await expect(
      controller.recordEvent({ ...VALID_BODY, artifactType: 'not-a-real-artifact-type' }),
    ).rejects.toThrow(BadRequestException);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects an unparseable observedAt before calling recordEvent', async () => {
    const { controller, recordEvent } = controllerWith();
    await expect(controller.recordEvent({ ...VALID_BODY, observedAt: 'not-a-date' })).rejects.toThrow(
      BadRequestException,
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('defaults observedAt to now when omitted', async () => {
    const { controller, recordEvent } = controllerWith();
    const { observedAt: _omit, ...body } = VALID_BODY;
    await controller.recordEvent(body);
    const input = recordEvent.mock.calls[0]?.[0] as { observedAt: Date };
    expect(input.observedAt).toBeInstanceOf(Date);
  });

  it('permits a null artifactType (some events have no versioned artifact)', async () => {
    const { controller, recordEvent } = controllerWith();
    await controller.recordEvent({ ...VALID_BODY, artifactType: null, artifactId: null });
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });
});
