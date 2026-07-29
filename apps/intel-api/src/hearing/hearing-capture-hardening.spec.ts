import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import {
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
  RecordingPolicyDto,
} from './dto/session.dto.js';
import type { HearingBriefService } from './hearing-brief.service.js';
import type { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import type { StreamResolverService } from './stream-resolver.service.js';
import type { HearingCryptoService } from './hearing-crypto.service.js';
import { HearingController } from './hearing.controller.js';
import { HearingSessionService } from './hearing-session.service.js';
import { PostHearingService } from './post-hearing.service.js';
import { SegmentCommitService } from './segment-commit.service.js';

interface SessionHarness {
  prisma: PrismaService;
  session: Record<string, unknown>;
  created: Array<Record<string, unknown>>;
  rawSql: string[];
  rawResults: unknown[][];
  findFirst: jest.Mock;
  findMany: jest.Mock;
}

function makeSessionHarness(): SessionHarness {
  const created: Array<Record<string, unknown>> = [];
  const rawSql: string[] = [];
  const rawResults: unknown[][] = [];
  const session = {
    id: 'session-1',
    tenantId: 'tenant-1',
    sourceType: 'hearing',
    audioSource: 'browser_mic',
    recordingPolicy: 'transcript_only',
    consentStatus: 'not_required',
    createdBy: 'user-1',
    clientId: null,
    matterId: null,
    issueIds: [],
    billIds: [],
    programElementIds: [],
    agencyIds: [],
    committeeId: null,
  };
  const findFirst = jest.fn(async () => session);
  const findMany = jest.fn(async () => [session]);
  const tx = {
    liveHearingSession: {
      findFirst,
      findMany,
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'created-session', ...data };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...session,
        ...data,
      })),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      rawSql.push(strings.join('?'));
      return rawResults.shift() ?? [];
    }),
  };
  const prisma = {
    withTenant: async <T>(_tenantId: string, fn: (inner: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return { prisma, session, created, rawSql, rawResults, findFirst, findMany };
}

describe('HearingSessionService capture ownership', () => {
  it('classifies private and client-linked sessions as sensitive without AI', () => {
    expect(HearingSessionService.isSensitiveSession({ sourceType: 'meeting' })).toBe(true);
    expect(
      HearingSessionService.isSensitiveSession({ sourceType: 'hearing', clientId: 'client-1' }),
    ).toBe(true);
    expect(
      HearingSessionService.isSensitiveSession({
        sourceType: 'hearing',
        issueIds: ['health-care'],
      }),
    ).toBe(true);
    expect(HearingSessionService.isSensitiveSession({ sourceType: 'hearing' })).toBe(false);
  });

  it('normalizes unsupported source and audio-retention requests to the implemented browser path', async () => {
    const h = makeSessionHarness();
    const svc = new HearingSessionService(h.prisma);

    await svc.create('tenant-1', 'user-1', {
      title: 'Committee hearing',
      sourceType: LiveHearingSourceTypeDto.hearing,
      audioSource: LiveHearingAudioSourceDto.stream_url,
      recordingPolicy: RecordingPolicyDto.audio_and_transcript,
      hearingId: 'hearing-1',
    });

    expect(h.created[0]).toMatchObject({
      audioSource: LiveHearingAudioSourceDto.browser_mic,
      hearingId: 'hearing-1',
      recordingPolicy: RecordingPolicyDto.transcript_only,
    });
  });

  it('scopes private session reads to the creator while keeping public proceedings team-visible', async () => {
    const h = makeSessionHarness();
    const svc = new HearingSessionService(h.prisma);

    await svc.getAccessible('tenant-1', 'session-1', 'user-2');

    expect(h.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        tenantId: 'tenant-1',
        OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-2' }],
      },
    });
  });

  it('returns the same 404 for a private session owned by another user', async () => {
    const h = makeSessionHarness();
    h.findFirst.mockResolvedValueOnce(null);
    const svc = new HearingSessionService(h.prisma);

    await expect(svc.getAccessible('tenant-1', 'private-session', 'user-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('filters My Sessions to public proceedings plus the caller private sessions', async () => {
    const h = makeSessionHarness();
    const svc = new HearingSessionService(h.prisma);

    await svc.list('tenant-1', 'user-2');

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-2' }],
        },
      }),
    );
  });

  it('claims preparation with one atomic UPDATE without marking the session live yet', async () => {
    const h = makeSessionHarness();
    const startedAt = new Date('2026-07-28T16:00:00.000Z');
    h.rawResults.push([{ started_at: startedAt }]);
    const svc = new HearingSessionService(h.prisma);

    await expect(svc.claimCapture('tenant-1', 'session-1')).resolves.toEqual({ startedAt });
    expect(h.rawSql[0]).toContain('UPDATE intel_live_hearing_session');
    expect(h.rawSql[0]).toContain("SET status = 'paused'");
    expect(h.rawSql[0]).toContain("status NOT IN ('live', 'paused')");
    expect(h.rawSql[0]).toContain('updated_at < now()');
    expect(h.rawSql[0]).toContain('RETURNING started_at');
  });

  it('rejects a second active capture when the atomic claim matches no row', async () => {
    const h = makeSessionHarness();
    h.rawResults.push([]);
    const svc = new HearingSessionService(h.prisma);
    await expect(svc.claimCapture('tenant-1', 'session-1')).resolves.toBeNull();
  });

  it('promotes only the owned preparation lease to live on first audio', async () => {
    const h = makeSessionHarness();
    h.rawResults.push([{ id: 'session-1' }]);
    const svc = new HearingSessionService(h.prisma);
    const token = new Date('2026-07-28T16:00:00.000Z');

    await expect(svc.activateCapture('tenant-1', 'session-1', token)).resolves.toBe(true);
    expect(h.rawSql[0]).toContain("SET status = 'live'");
    expect(h.rawSql[0]).toContain("status = 'paused'");
    expect(h.rawSql[0]).toContain('started_at =');
  });

  it('heartbeats and releases only the exact started_at claim token', async () => {
    const h = makeSessionHarness();
    h.rawResults.push([{ id: 'session-1' }], [{ id: 'session-1' }]);
    const svc = new HearingSessionService(h.prisma);
    const token = new Date('2026-07-28T16:00:00.000Z');

    await expect(svc.heartbeatCapture('tenant-1', 'session-1', token)).resolves.toBe(true);
    await expect(svc.releaseCapture('tenant-1', 'session-1', token, 'ended')).resolves.toBe(true);

    expect(h.rawSql[0]).toContain("status IN ('paused', 'live')");
    expect(h.rawSql[0]).toContain('started_at =');
    expect(h.rawSql[1]).toContain('started_at =');
    expect(h.rawSql[1]).toContain("status = 'ended'");
  });
});

interface SegmentHarness {
  prisma: PrismaService;
  create: jest.Mock;
  findFirst: jest.Mock;
  updateMany: jest.Mock;
  aggregate: jest.Mock;
  entityCreate: jest.Mock;
  keyQuoteCreate: jest.Mock;
  actionCreate: jest.Mock;
  cardCreate: jest.Mock;
}

function makeSegmentHarness(): SegmentHarness {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'segment-1',
    ...data,
  }));
  const findFirst = jest.fn(async () => null);
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const aggregate = jest.fn(async () => ({ _max: { endMs: 42_000 } }));
  const entityCreate = jest.fn(async () => ({}));
  const keyQuoteCreate = jest.fn(async () => ({}));
  const actionCreate = jest.fn(async () => ({}));
  const cardCreate = jest.fn(async () => ({}));
  const tx = {
    transcriptSegment: { create, findFirst, updateMany, aggregate },
    entityMention: { create: entityCreate },
    keyQuote: { create: keyQuoteCreate },
    liveActionItem: { create: actionCreate },
    liveSummaryCard: { create: cardCreate },
  };
  const prisma = {
    withTenant: async <T>(_tenantId: string, fn: (inner: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return {
    prisma,
    create,
    findFirst,
    updateMany,
    aggregate,
    entityCreate,
    keyQuoteCreate,
    actionCreate,
    cardCreate,
  };
}

function cryptoHarness(configured: boolean): HearingCryptoService {
  return {
    configured,
    encrypt: jest.fn((text: string) => ({
      textCiphertext: `cipher:${text}`,
      iv: 'iv',
      authTag: 'tag',
      keyVersion: 'v1',
    })),
    decrypt: jest.fn(),
  } as unknown as HearingCryptoService;
}

const finalSegment = {
  startMs: 1_000,
  endMs: 2_000,
  text: 'Sensitive client position discussed.',
  confidence: 0.98,
};

describe('SegmentCommitService sensitive storage', () => {
  it('persists a forced-sensitive transcript encrypted before enrichment runs', async () => {
    const h = makeSegmentHarness();
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));

    await svc.commitRawFinal({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      recordingPolicy: 'transcript_only',
      segment: finalSegment,
      forceEncrypt: true,
    });

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          textPlain: null,
          textCiphertext: `cipher:${finalSegment.text}`,
          iv: 'iv',
          authTag: 'tag',
        }),
      }),
    );
  });

  it('fails closed rather than storing sensitive plaintext when encryption is unavailable', async () => {
    const h = makeSegmentHarness();
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(false));

    await svc.commitRawFinal({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      recordingPolicy: 'transcript_only',
      segment: finalSegment,
      forceEncrypt: true,
    });

    expect(h.create.mock.calls[0]?.[0].data).toMatchObject({
      textPlain: null,
      textCiphertext: null,
    });
  });

  it('encrypts sensitive action/card/entity prose instead of discarding it', async () => {
    const h = makeSegmentHarness();
    h.findFirst.mockResolvedValue({
      textPlain: null,
      textCiphertext: 'cipher:already-protected',
      iv: 'iv',
      authTag: 'tag',
      keyVersion: 'v1',
    });
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));

    await svc.enrichFinal({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      segmentId: 'segment-1',
      segment: finalSegment,
      forceEncrypt: true,
      extraction: {
        entityMentions: [
          {
            entityType: 'company',
            entityRef: 'client-1',
            entityLabel: 'Sensitive Client Name',
          },
        ],
        issueTags: ['sensitive-policy'],
        actionItem: { description: 'Privately contact the member.' },
        summaryCard: {
          cardType: 'potential_ask',
          title: 'Sensitive client ask',
          body: 'Do not store this as plaintext.',
        },
        keyQuote: {
          text: 'A sensitive quote.',
          issueTags: ['sensitive-policy'],
        },
        resolvedSpeakerName: 'Private Participant',
      },
    });

    // These three tables gained encrypted columns in
    // 20260803040000_hearing_derived_encrypted_text. Before that they were
    // plaintext-only, so a sensitive session's derived prose was DISCARDED — which
    // silently starved every post-hearing recap for a client-linked hearing.
    // Now it is encrypted and persisted: plaintext column null, ciphertext set.
    expect(h.entityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityLabel: null,
          textCiphertext: 'cipher:Sensitive Client Name',
          // Category and canonical id are not free text and stay queryable.
          entityType: 'company',
          entityRef: 'client-1',
        }),
      }),
    );
    expect(h.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: null,
          textCiphertext: 'cipher:Privately contact the member.',
        }),
      }),
    );
    expect(h.cardCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: null,
          titleCiphertext: 'cipher:Sensitive client ask',
          body: null,
          bodyCiphertext: 'cipher:Do not store this as plaintext.',
          // cardType stays plaintext: the supporters/opponents split matches on it.
          cardType: 'potential_ask',
        }),
      }),
    );
    expect(h.keyQuoteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          textPlain: null,
          textCiphertext: 'cipher:A sensitive quote.',
          speakerName: null,
        }),
      }),
    );
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolvedSpeakerName: null }),
      }),
    );
  });

  it('upgrades an already-stored public segment to encrypted when relevance is established later', async () => {
    const h = makeSegmentHarness();
    h.findFirst.mockResolvedValue({
      textPlain: 'Client-specific language',
      textCiphertext: null,
      iv: null,
      authTag: null,
      keyVersion: null,
    });
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));

    await svc.protectSegmentText('tenant-1', 'session-1', 'segment-1');

    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'segment-1',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        textPlain: 'Client-specific language',
      },
      data: {
        textCiphertext: 'cipher:Client-specific language',
        iv: 'iv',
        authTag: 'tag',
        keyVersion: 'v1',
        textPlain: null,
      },
    });
  });

  it('treats a replayed final as a no-op rather than a second segment', async () => {
    const h = makeSegmentHarness();
    // The unique (sessionId,startMs,endMs) rejects the duplicate insert.
    h.create.mockRejectedValueOnce(
      Object.assign(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
        {},
      ),
    );
    h.findFirst.mockResolvedValueOnce({ id: 'segment-existing' });
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));

    const result = await svc.commitRawFinal({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      recordingPolicy: 'transcript_only',
      segment: finalSegment,
      forceEncrypt: false,
    });

    // created:false is what stops the caller re-running enrichment (and re-firing
    // watchlist alerts) over a segment that was already fully processed.
    expect(result).toEqual({ id: 'segment-existing', created: false });
  });

  it('persists nothing at all under a no_storage session', async () => {
    const h = makeSegmentHarness();
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));

    const result = await svc.commitRawFinal({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      recordingPolicy: 'no_storage',
      segment: finalSegment,
      forceEncrypt: true,
    });

    expect(result).toEqual({ id: null, created: false });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('uses the persisted maximum timestamp as the next capture timeline offset', async () => {
    const h = makeSegmentHarness();
    const svc = new SegmentCommitService(h.prisma, cryptoHarness(true));
    await expect(svc.maxEndMs('tenant-1', 'session-1')).resolves.toBe(42_000);
    expect(h.aggregate).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', sessionId: 'session-1', isFinal: true },
      _max: { endMs: true },
    });
  });
});

describe('persisted transcript reads', () => {
  function makeTranscriptHarness(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_unused, i) => ({
      id: `segment-${i}`,
      startMs: i * 1_000,
      endMs: i * 1_000 + 900,
      speakerLabel: 'Speaker 1',
      resolvedSpeakerName: null,
      confidence: 0.9,
      textCiphertext: null,
      iv: null,
      authTag: null,
      textPlain: `line ${i}`,
    }));
    const findMany = jest.fn(async ({ skip, take }: { skip: number; take: number }) =>
      rows.slice(skip, skip + take),
    );
    const tx = {
      liveHearingSession: { findFirst: jest.fn(async () => ({ id: 'session-1' })) },
      transcriptSegment: { findMany },
    };
    const prisma = {
      withTenant: async <T>(_tenantId: string, fn: (inner: typeof tx) => Promise<T>) => fn(tx),
    } as unknown as PrismaService;
    return { svc: new PostHearingService(prisma, cryptoHarness(true)), findMany };
  }

  it('returns a bounded page in deterministic order with a usable next offset', async () => {
    const h = makeTranscriptHarness(7);

    const page = await h.svc.transcript('tenant-1', 'session-1', { offset: 0, limit: 5 });

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', sessionId: 'session-1', isFinal: true },
        // Deterministic across pages — `startMs` alone can tie.
        orderBy: [{ startMs: 'asc' }, { id: 'asc' }],
        skip: 0,
        // One extra row is read purely to answer hasMore without a count query.
        take: 6,
      }),
    );
    expect(page?.items).toHaveLength(5);
    expect(page?.hasMore).toBe(true);
    expect(page?.nextOffset).toBe(5);
  });

  it('reports the end of the transcript instead of an endless next page', async () => {
    const h = makeTranscriptHarness(3);
    const page = await h.svc.transcript('tenant-1', 'session-1', { offset: 0, limit: 250 });
    expect(page?.items.map((i) => i.text)).toEqual(['line 0', 'line 1', 'line 2']);
    expect(page?.hasMore).toBe(false);
    expect(page?.nextOffset).toBeNull();
  });

  it('never loads an unbounded page even when the client asks for one', async () => {
    const h = makeTranscriptHarness(2);
    await h.svc.transcript('tenant-1', 'session-1', { offset: -5, limit: 100_000 });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 501 }));
  });

  it('authorizes the transcript endpoint through the private-session boundary', async () => {
    const getAccessible = jest.fn(async () => {
      throw new NotFoundException('Live hearing session not found');
    });
    const transcript = jest.fn();
    const controller = new HearingController(
      { getAccessible } as unknown as HearingSessionService,
      { transcript } as unknown as PostHearingService,
      {} as HearingBriefService,
      {} as StreamResolverService,
      {} as HearingWsTicketService,
    );
    const ctx = { tenantId: 'tenant-1', clerkUserId: 'user-2' } as WorkspaceTenantContext;

    // A same-tenant user who guesses a private session id gets the same 404 as a
    // missing row, and the transcript is never read.
    await expect(controller.transcript(ctx, 'private-session')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getAccessible).toHaveBeenCalledWith('tenant-1', 'private-session', 'user-2');
    expect(transcript).not.toHaveBeenCalled();
  });

  it('passes only sane pagination values from the query string to the service', async () => {
    const transcript = jest.fn(async () => ({ items: [], hasMore: false, nextOffset: null }));
    const controller = new HearingController(
      {
        getAccessible: jest.fn(async () => ({ id: 'session-1' })),
      } as unknown as HearingSessionService,
      { transcript } as unknown as PostHearingService,
      {} as HearingBriefService,
      {} as StreamResolverService,
      {} as HearingWsTicketService,
    );
    const ctx = { tenantId: 'tenant-1', clerkUserId: 'user-1' } as WorkspaceTenantContext;

    await controller.transcript(ctx, 'session-1', '500', '250');
    expect(transcript).toHaveBeenCalledWith('tenant-1', 'session-1', { offset: 500, limit: 250 });

    await controller.transcript(ctx, 'session-1', 'not-a-number', '-3');
    expect(transcript).toHaveBeenLastCalledWith('tenant-1', 'session-1', {
      offset: undefined,
      limit: undefined,
    });
  });
});
