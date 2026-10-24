import { BadRequestException } from '@nestjs/common';
import { HearingSessionService } from '../src/hearing/hearing-session.service.js';
import {
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
} from '../src/hearing/dto/session.dto.js';

/**
 * P8 (spec D11): consent attestation is required ONLY for PRIVATE source types
 * (meeting/webinar/agency_session) and enforced SERVER-SIDE in create(). Public
 * hearing/markup skip it. Tested with a stub PrismaService (no DB).
 */
describe('HearingSessionService — consent conditional on source type', () => {
  function svc() {
    let created: any = null;
    const tx = {
      liveHearingSession: {
        create: async ({ data }: { data: any }) => {
          created = data;
          return { id: 'sess-1', ...data };
        },
      },
    };
    const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: (db: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { service: new HearingSessionService(prisma as never), prisma, getCreated: () => created };
  }

  const base = {
    title: 'X',
    audioSource: LiveHearingAudioSourceDto.stream_url,
  };

  it('requiresConsent flags only the private source types', () => {
    expect(HearingSessionService.requiresConsent('meeting')).toBe(true);
    expect(HearingSessionService.requiresConsent('webinar')).toBe(true);
    expect(HearingSessionService.requiresConsent('agency_session')).toBe(true);
    expect(HearingSessionService.requiresConsent('hearing')).toBe(false);
    expect(HearingSessionService.requiresConsent('markup')).toBe(false);
  });

  it('public hearing needs NO attestation → not_required', async () => {
    const { service, getCreated } = svc();
    const s = await service.create('t1', 'u1', {
      ...base,
      sourceType: LiveHearingSourceTypeDto.hearing,
    } as any);
    expect(getCreated().consentStatus).toBe('not_required');
    expect(s.consentStatus).toBe('not_required');
  });

  it('public markup ignores an attestation and stays not_required', async () => {
    const { service, getCreated } = svc();
    await service.create('t1', 'u1', {
      ...base,
      sourceType: LiveHearingSourceTypeDto.markup,
      consentAttestation: 'ignored for public',
    } as any);
    expect(getCreated().consentStatus).toBe('not_required');
  });

  it('private meeting WITHOUT attestation is rejected (400)', async () => {
    const { service, prisma, getCreated } = svc();
    await expect(
      service.create('t1', 'u1', {
        ...base,
        sourceType: LiveHearingSourceTypeDto.meeting,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(getCreated()).toBeNull();
  });

  it('private meeting with a blank attestation is rejected (400)', async () => {
    const { service, prisma, getCreated } = svc();
    await expect(
      service.create('t1', 'u1', {
        ...base,
        sourceType: LiveHearingSourceTypeDto.webinar,
        consentAttestation: '   ',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(getCreated()).toBeNull();
  });

  it('private session WITH attestation → confirmed', async () => {
    const { service, getCreated } = svc();
    const s = await service.create('t1', 'u1', {
      ...base,
      sourceType: LiveHearingSourceTypeDto.agency_session,
      consentAttestation: 'I am authorized to capture this session.',
    } as any);
    expect(getCreated().consentStatus).toBe('confirmed');
    expect(s.consentStatus).toBe('confirmed');
  });

  it('private session PERSISTS the full attestation + attestedBy/attestedAt', async () => {
    const { service, prisma, getCreated } = svc();
    // Longer than the 80-char truncated log to prove the FULL text is stored.
    const full =
      'I attest, on behalf of the firm, that all parties to this private agency ' +
      'session have consented to its capture and transcription for legal work product.';
    const before = Date.now();
    await service.create('tenant-A', 'user-42', {
      ...base,
      sourceType: LiveHearingSourceTypeDto.meeting,
      consentAttestation: `   ${full}   `, // leading/trailing space is trimmed
    } as any);
    const created = getCreated();
    expect(prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-A', expect.any(Function));
    expect(created.tenantId).toBe('tenant-A');
    expect(created.consentAttestation).toBe(full);
    expect(created.consentAttestation.length).toBeGreaterThan(80);
    expect(created.attestedBy).toBe('user-42');
    expect(created.attestedAt).toBeInstanceOf(Date);
    expect((created.attestedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('public session does NOT persist an attestation record', async () => {
    const { service, getCreated } = svc();
    await service.create('t1', 'u1', {
      ...base,
      sourceType: LiveHearingSourceTypeDto.hearing,
      consentAttestation: 'ignored for public',
    } as any);
    const created = getCreated();
    expect(created.consentAttestation).toBeNull();
    expect(created.attestedBy).toBeNull();
    expect(created.attestedAt).toBeNull();
  });

  it('does not persist consent or report a session when the tenant transaction fails', async () => {
    const { service, prisma, getCreated } = svc();
    const failure = new Error('tenant transaction unavailable');
    prisma.withTenant.mockRejectedValueOnce(failure);
    await expect(service.create('t1', 'u1', {
      ...base, sourceType: LiveHearingSourceTypeDto.meeting, consentAttestation: 'Authorized synthetic session',
    } as any)).rejects.toBe(failure);
    expect(getCreated()).toBeNull();
  });
});
