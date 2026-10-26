import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import { OutreachTemplateController } from './outreach-template.controller.js';
import { recoveryFixture } from './outreach-template-recovery-fixture.test.js';

describe('WS20 exact publication', () => {
  it('requires a valid expected draft through both HTTP DTO and service', async () => {
    const dto = Reflect.getMetadata(
      'design:paramtypes',
      OutreachTemplateController.prototype,
      'publish',
    )[2];
    expect(dto).toBeDefined();
    for (const body of [{}, { expectedDraftVersionId: 'not-a-version' }]) {
      expect(await validate(plainToInstance(dto, body))).not.toHaveLength(0);
      const h = recoveryFixture();
      await expect(h.service.publish(h.ctx, h.template.id, body as never)).rejects.toMatchObject({
        code: 'OUTREACH_COMMAND_INVALID',
        httpStatus: 400,
      });
      expect(h.templates.publishDraft).not.toHaveBeenCalled();
    }
  });

  it('relays the expected version to the owner and publishes that current draft', async () => {
    const h = recoveryFixture();
    const result = await new OutreachTemplateController(h.service).publish(h.ctx, h.template.id, {
      expectedDraftVersionId: h.version.id,
    });
    expect(result).toMatchObject({
      templateId: h.template.id,
      version: { id: h.version.id },
      published: true,
      replayed: false,
    });
    expect(h.templates.publishDraft).toHaveBeenCalledTimes(1);
  });

  it.each(['draft', 'superseded'] as const)(
    'refuses a stale %s version without publishing the newer draft',
    async (lifecycle) => {
      const h = recoveryFixture();
      h.version.lifecycle = lifecycle;
      h.template.currentDraftVersionId = randomUUID();
      await expect(
        h.service.publish(h.ctx, h.template.id, { expectedDraftVersionId: h.version.id }),
      ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_VERSION_IMMUTABLE', httpStatus: 409 });
      expect(h.templates.publishDraft).not.toHaveBeenCalled();
    },
  );

  it('recovers an exact older publication after a newer draft and publication exist', async () => {
    const h = recoveryFixture();
    h.version.lifecycle = 'published';
    h.template.currentDraftVersionId = randomUUID();
    h.template.publishedVersionId = randomUUID();
    const result = await h.service.publish(h.ctx, h.template.id, {
      expectedDraftVersionId: h.version.id,
    });
    expect(result).toMatchObject({
      version: { id: h.version.id },
      published: true,
      replayed: true,
    });
    expect(h.templates.publishDraft).not.toHaveBeenCalled();
    expect(h.templates.recordAudit).not.toHaveBeenCalled();
  });

  it('rejects a version belonging to a different template', async () => {
    const h = recoveryFixture();
    h.version.templateId = randomUUID();
    h.version.lifecycle = 'published';
    await expect(
      h.service.publish(h.ctx, h.template.id, { expectedDraftVersionId: h.version.id }),
    ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_VERSION_IMMUTABLE' });
    expect(h.templates.publishDraft).not.toHaveBeenCalled();
  });

  it('rechecks current client/wall access even for a publication replay', async () => {
    const h = recoveryFixture();
    h.version.lifecycle = 'published';
    h.template.clientId = randomUUID();
    h.authorization.authorizeClientWithinTx.mockRejectedValue(
      new CapabilityError('CAPABILITY_ETHICAL_WALL', 'Restricted'),
    );
    await expect(
      h.service.publish(h.ctx, h.template.id, { expectedDraftVersionId: h.version.id }),
    ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_SCOPE_UNAUTHORIZED' });
    expect(h.templates.publishDraft).not.toHaveBeenCalled();
  });
});

describe('WS20 application recovery', () => {
  it('replays the original receipt after republish, before reading any current version', async () => {
    const h = recoveryFixture();
    h.templates.findApplicationByRequestKey.mockResolvedValue(h.application);
    h.template.publishedVersionId = randomUUID();
    h.templates.getVersion.mockResolvedValue({
      ...h.version,
      id: h.template.publishedVersionId,
      lifecycle: 'published',
      versionNumber: 2,
    });
    const result = await h.service.usePublished(h.ctx, h.template.id, h.input);
    expect(result).toMatchObject({
      sessionId: h.application.sessionId,
      stateVersion: 2,
      templateVersionId: h.application.templateVersionId,
      applicationId: h.application.id,
      replayed: true,
      receipt: h.application.receiptJsonb,
    });
    expect(h.templates.getVersion).not.toHaveBeenCalled();
    expect(h.state.createSessionWithinTx).not.toHaveBeenCalled();
    expect(h.sessions.loadCurrentSpecWithinTx).toHaveBeenCalledWith(
      h.tx,
      h.ctx,
      h.application.sessionId,
    );
    expect(h.templates.lockApplicationRequest.mock.invocationCallOrder[0]).toBeLessThan(
      h.templates.findApplicationByRequestKey.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['title', 'clientId', 'variableValues', 'templateId'])(
    'refuses changed %s under the original key',
    async (field) => {
      const h = recoveryFixture();
      h.templates.findApplicationByRequestKey.mockResolvedValue(h.application);
      const input = {
        ...h.input,
        ...(field === 'title'
          ? { title: 'Changed title' }
          : field === 'clientId'
            ? { clientId: randomUUID() }
            : field === 'variableValues'
              ? { variableValues: { answer: 'Changed' } }
              : {}),
      };
      if (field === 'templateId') h.template.id = randomUUID();
      await expect(h.service.usePublished(h.ctx, h.template.id, input)).rejects.toMatchObject({
        code: 'OUTREACH_TEMPLATE_REQUEST_REUSE',
        httpStatus: 409,
      });
      expect(h.state.createSessionWithinTx).not.toHaveBeenCalled();
    },
  );

  it('denies replay when the resulting campaign is no longer owned', async () => {
    const h = recoveryFixture();
    h.templates.findApplicationByRequestKey.mockResolvedValue(h.application);
    h.sessions.loadCurrentSpecWithinTx.mockRejectedValue({ code: 'OUTREACH_SESSION_NOT_FOUND' });
    await expect(h.service.usePublished(h.ctx, h.template.id, h.input)).rejects.toMatchObject({
      code: 'OUTREACH_SESSION_NOT_FOUND',
    });
    expect(h.state.createSessionWithinTx).not.toHaveBeenCalled();
  });

  it('waits for same-key work before looking up its receipt or creating any session', async () => {
    const h = recoveryFixture();
    let release!: () => void;
    h.templates.lockApplicationRequest.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.service.usePublished(h.ctx, h.template.id, h.input);
    const settled = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const waiting = typeof release === 'function';
    const lookupsBeforeRelease = h.templates.findApplicationByRequestKey.mock.calls.length;
    const createsBeforeRelease = h.state.createSessionWithinTx.mock.calls.length;
    h.templates.findApplicationByRequestKey.mockResolvedValue(h.application);
    release?.();
    const outcome = await settled;
    expect(waiting).toBe(true);
    expect(lookupsBeforeRelease).toBe(0);
    expect(createsBeforeRelease).toBe(0);
    expect(outcome).toMatchObject({
      result: { replayed: true, sessionId: h.application.sessionId },
    });
    expect(h.state.createSessionWithinTx).not.toHaveBeenCalled();
  });
});

describe('WS20 provenance authorization', () => {
  it('returns null for an accessible ordinary session after checking current state', async () => {
    const h = recoveryFixture();
    h.templates.getProvenanceForSession.mockResolvedValue(null);
    await expect(h.service.getProvenance(h.ctx, h.application.sessionId)).resolves.toBeNull();
    expect(h.sessions.loadCurrentSpecWithinTx).toHaveBeenCalledWith(
      h.tx,
      h.ctx,
      h.application.sessionId,
    );
  });

  it('denies missing/foreign ownership before reading provenance', async () => {
    const h = recoveryFixture();
    h.sessions.loadCurrentSpecWithinTx.mockRejectedValue({ code: 'OUTREACH_SESSION_NOT_FOUND' });
    await expect(h.service.getProvenance(h.ctx, h.application.sessionId)).rejects.toMatchObject({
      code: 'OUTREACH_SESSION_NOT_FOUND',
    });
    expect(h.templates.getProvenanceForSession).not.toHaveBeenCalled();
  });

  it('checks every current sponsor client and the original template client without leaking the internal field', async () => {
    const h = recoveryFixture();
    const clients = [randomUUID(), randomUUID(), randomUUID()];
    const spec = await h.sessions.loadCurrentSpecWithinTx();
    spec.sponsor = {
      kind: 'multi_client',
      clientRefs: clients.slice(0, 2).map((clientId) => ({ clientId })),
    } as typeof spec.sponsor;
    h.sessions.loadCurrentSpecWithinTx.mockResolvedValue(spec);
    h.templates.getProvenanceForSession.mockResolvedValue({
      templateClientId: clients[2],
      receiptJsonb: h.application.receiptJsonb,
    });
    await expect(h.service.getProvenance(h.ctx, h.application.sessionId)).resolves.toEqual({
      receiptJsonb: h.application.receiptJsonb,
    });
    expect(
      h.authorization.authorizeClientWithinTx.mock.calls.map((call) => (call as unknown[])[2]),
    ).toEqual(clients);
  });

  it.each(['current session', 'provenance template'])(
    'refuses a revoked %s client',
    async (source) => {
      const h = recoveryFixture();
      const clientId = randomUUID();
      if (source === 'current session') {
        const spec = await h.sessions.loadCurrentSpecWithinTx();
        spec.sponsor = { kind: 'client', clientRefs: [{ clientId }] } as typeof spec.sponsor;
        h.sessions.loadCurrentSpecWithinTx.mockResolvedValue(spec);
      }
      h.templates.getProvenanceForSession.mockResolvedValue({
        templateClientId: source === 'provenance template' ? clientId : null,
      });
      h.authorization.authorizeClientWithinTx.mockRejectedValue(
        new CapabilityError('CAPABILITY_ETHICAL_WALL', 'Restricted'),
      );
      await expect(h.service.getProvenance(h.ctx, h.application.sessionId)).rejects.toMatchObject({
        code: 'OUTREACH_TEMPLATE_SCOPE_UNAUTHORIZED',
      });
      if (source === 'current session')
        expect(h.templates.getProvenanceForSession).not.toHaveBeenCalled();
    },
  );
});
