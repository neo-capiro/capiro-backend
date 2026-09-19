import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { HearingBrief } from './hearing-watch-api.js';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('./use-api.js', () => ({ useApi: () => ({ get: apiGet, post: apiPost }) }));
vi.mock('./use-api-scope.js', () => ({ useApiScope: () => 'test-tenant:test-user' }));

const {
  briefToMarkdown,
  isMediaUrl,
  mediaKindOf,
  useCurrentHearingRecap,
  useGenerateBrief,
  useHearingTranscript,
  useSaveRecap,
} = await import('./hearing-watch-api.js');

function withQueryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe('isMediaUrl', () => {
  test('recognizes direct media file URLs', () => {
    expect(isMediaUrl('https://example.com/hearing.m3u8')).toBe(true);
    expect(isMediaUrl('https://example.com/hearing.mp4?x=1')).toBe(true);
    expect(isMediaUrl('https://example.com/audio.mp3#t=10')).toBe(true);
  });

  test('recognizes stream/manifest/playlist as a distinct path segment', () => {
    expect(isMediaUrl('https://example.com/hls/stream/index')).toBe(true);
    expect(isMediaUrl('https://example.com/hls-manifest/x')).toBe(true);
    expect(isMediaUrl('https://example.com/playlist.txt')).toBe(true);
  });

  test('does NOT false-positive on ordinary event pages mentioning stream', () => {
    expect(isMediaUrl('https://oversight.house.gov/hearings/watch-livestream')).toBe(false);
    expect(isMediaUrl('https://example.com/committee/streaming-schedule')).toBe(false);
    expect(isMediaUrl('https://www.congress.gov/committee-schedule/mainstream-media-day')).toBe(
      false,
    );
  });

  test('does not match a plain event/committee page', () => {
    expect(isMediaUrl('https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=1')).toBe(
      false,
    );
    expect(isMediaUrl('https://www.congress.gov/event/x')).toBe(false);
  });

  test('handles null/undefined', () => {
    expect(isMediaUrl(null)).toBe(false);
    expect(isMediaUrl(undefined)).toBe(false);
  });
});

describe('mediaKindOf', () => {
  test('routes HLS, progressive video and audio to different players', () => {
    expect(mediaKindOf('https://example.gov/live/master.m3u8')).toBe('hls');
    expect(mediaKindOf('https://example.gov/archive/hearing.mp4')).toBe('video');
    expect(mediaKindOf('https://example.gov/audio/hearing.mp3')).toBe('audio');
    expect(mediaKindOf('https://example.gov/audio/hearing.aac?download=1')).toBe('audio');
  });

  test('does not claim an event page has a playable media kind', () => {
    expect(mediaKindOf('https://www.congress.gov/event/x')).toBe('unknown');
  });
});

describe('briefToMarkdown', () => {
  const base = {
    sessionId: 'session-1',
    title: 'House Armed Services hearing',
    generatedAt: '2026-07-28T16:00:00.000Z',
    executiveSummary: 'The committee discussed acquisition reform.',
    keyMoments: [],
    relevantQuotes: [],
    supporters: [],
    opponents: [],
    tone: 'constructive',
    risks: [],
    opportunities: [],
    recommendedNextSteps: ['Follow up with committee staff.'],
    draftClientEmail: { subject: 'Update', body: 'Body' },
    synthesisSource: 'orchestrator' as const,
  };

  test('renders the model narrative with readable merged timestamp-range citations and NO opaque ids', () => {
    const markdown = briefToMarkdown({
      ...base,
      summaryTitle: 'Acquisition reform in focus',
      keyDevelopments: [
        {
          title: 'Faster acquisition',
          text: 'Witnesses urged a faster acquisition process.',
          evidenceIds: ['segment-7', 'segment-7', 'segment-8', 'segment-9', 'foreign-id'],
        },
      ],
      claimMap: [
        // Two contiguous ASR fragments (gap 500ms <= 1000ms) merge into one range.
        { claimId: 'claim-1', segmentId: 'segment-7', timestampMs: 125_000, endMs: 129_500 },
        { claimId: 'claim-2', segmentId: 'segment-8', timestampMs: 130_000, endMs: 134_000 },
        // A later, separate segment (real end) stays its own range.
        { claimId: 'claim-3', segmentId: 'segment-9', timestampMs: 250_000, endMs: 254_000 },
      ],
    });

    // New narrative present, concise title used.
    expect(markdown).toContain('# Acquisition reform in focus');
    expect(markdown).toContain('### Faster acquisition');
    expect(markdown).toContain('Witnesses urged a faster acquisition process\\.');
    // Merged range 2:05–2:14 (125s–134s), then a distinct 4:10–4:14 range.
    expect(markdown).toContain('_Cited at 2:05–2:14 · 4:10–4:14_');
    // No opaque machine ids or source-anchor wall.
    expect(markdown).not.toContain('[segment:');
    expect(markdown).not.toContain('claim-1');
    expect(markdown).not.toContain('Source anchors');
    // Formal title retained as provenance (distinct from summaryTitle).
    expect(markdown).toContain('_Hearing: House Armed Services hearing_');
    // Real session retrieval link.
    expect(markdown).toContain('(/intelligence/hearing-watch/session-1)');
    expect(markdown).toContain('Follow up with committee staff\\.');
  });

  test('citations merge only contiguous/overlapping real-ended segments; legacy points never merge or infer ends', () => {
    const briefFor = (claimMap: HearingBrief['claimMap'], ids: string[]) =>
      briefToMarkdown({
        ...base,
        keyDevelopments: [{ title: 'D', text: 'T.', evidenceIds: ids }],
        claimMap,
      });
    const line = (md: string) => md.split('\n').find((l) => l.startsWith('_Cited at '));

    // Fragmented: gap > 1000ms → two distinct ranges preserved.
    const fragmented = line(
      briefFor(
        [
          { claimId: 'a', segmentId: 's1', timestampMs: 10_000, endMs: 12_000 },
          { claimId: 'b', segmentId: 's2', timestampMs: 20_000, endMs: 22_000 },
        ],
        ['s1', 's2'],
      ),
    );
    expect(fragmented).toBe('_Cited at 0:10–0:12 · 0:20–0:22_');

    // Continuous: overlapping/contiguous → one merged range.
    const continuous = line(
      briefFor(
        [
          { claimId: 'a', segmentId: 's1', timestampMs: 10_000, endMs: 15_000 },
          { claimId: 'b', segmentId: 's2', timestampMs: 14_500, endMs: 20_000 },
        ],
        ['s1', 's2'],
      ),
    );
    expect(continuous).toBe('_Cited at 0:10–0:20_');

    // Legacy point (no endMs) never merges and never gets an inferred end.
    const legacy = line(
      briefFor(
        [
          { claimId: 'a', segmentId: 's1', timestampMs: 10_000 }, // no endMs
          { claimId: 'b', segmentId: 's2', timestampMs: 10_500, endMs: 12_000 },
        ],
        ['s1', 's2'],
      ),
    );
    expect(legacy).toBe('_Cited at 0:10 · 0:10–0:12_');
  });

  test('escapes Markdown special characters in model/title text so it cannot inject structure', () => {
    const markdown = briefToMarkdown({
      ...base,
      summaryTitle: '**Not bold** # nope',
      executiveSummary: 'See [this](https://evil.example) and <script>alert(1)</script>.',
    });
    // Interpolated model text is escaped — it renders literally, not as markup.
    expect(markdown).toContain('\\*\\*Not bold\\*\\*');
    expect(markdown).not.toContain('](https://evil.example)');
    expect(markdown).toContain('\\[this\\]\\(https://evil\\.example\\)');
    expect(markdown).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
  });

  test('states coverage against the available recording, never the whole hearing', () => {
    const full = briefToMarkdown({
      ...base,
      sourceCoverage: {
        availableSegments: 138,
        includedSegments: 138,
        startMs: 15_000,
        endMs: 676_000,
        limited: false,
      },
    });
    expect(full).toContain('all 138 captured transcript segments');
    expect(full).toContain('of the available recording');
    expect(full).not.toMatch(/whole hearing|entire hearing|full hearing/i);

    const bounded = briefToMarkdown({
      ...base,
      sourceCoverage: {
        availableSegments: 138,
        includedSegments: 60,
        startMs: 15_000,
        endMs: 300_000,
        limited: true,
      },
    });
    expect(bounded).toContain('60 of 138 captured transcript segments');
    // Omitted count derived when not explicit (138-60=78).
    expect(bounded).toContain('78 segments not included');
  });

  test('distinguishes shortened text from omitted segments — "all segments" is not "all text"', () => {
    // All segments included, but some text was shortened: must NOT read as full text.
    const truncated = briefToMarkdown({
      ...base,
      sourceCoverage: {
        availableSegments: 138,
        includedSegments: 138,
        startMs: 15_000,
        endMs: 676_000,
        limited: true,
        truncatedSegments: 12,
        omittedSegments: 0,
      },
    });
    expect(truncated).toContain('138 of 138 captured transcript segments');
    expect(truncated).toContain('12 segments shortened for length');
    expect(truncated).not.toContain('not included');

    // Both omitted and truncated.
    const both = briefToMarkdown({
      ...base,
      sourceCoverage: {
        availableSegments: 200,
        includedSegments: 150,
        startMs: 0,
        endMs: 600_000,
        limited: true,
        truncatedSegments: 5,
        omittedSegments: 50,
      },
    });
    expect(both).toContain('150 of 200 captured transcript segments');
    expect(both).toContain('50 segments not included');
    expect(both).toContain('5 segments shortened for length');
  });

  test('does not print claim counts or unverifiable record-metadata claims', () => {
    const markdown = briefToMarkdown({
      ...base,
      claimMap: [{ claimId: 'claim-1', segmentId: 'segment-1', timestampMs: 1_000 }],
    });
    expect(markdown).not.toMatch(/\d+ claims?/);
    expect(markdown).not.toContain('recap record');
    expect(markdown).not.toContain('further anchor');
  });

  test('falls back to legacy keyMoments for older briefs without keyDevelopments', () => {
    const markdown = briefToMarkdown({
      ...base,
      keyDevelopments: undefined,
      keyMoments: [
        {
          segmentId: 'segment-7',
          timestampMs: 125_000,
          speakerName: 'Chair Smith',
          text: 'We need a faster acquisition process.',
        },
      ],
    });
    expect(markdown).toContain('## Key moments');
    // mdEscape escapes the trailing period (CommonMark-safe; renders identically).
    expect(markdown).toContain('**2:05** Chair Smith: We need a faster acquisition process\\.');
    expect(markdown).not.toContain('[segment:');
  });
});

describe('briefToMarkdown — client context', () => {
  const base = {
    sessionId: 's1',
    title: 'HASC Hearing',
    generatedAt: '2026-09-08T12:00:00.000Z',
    executiveSummary: 'Summary.',
    keyMoments: [],
    relevantQuotes: [],
    supporters: [],
    opponents: [],
    tone: 'neutral',
    risks: [],
    opportunities: [],
    recommendedNextSteps: [],
    draftClientEmail: { subject: 's', body: 'b' },
    synthesisSource: 'orchestrator' as const,
  };

  test('names the client the recap was written for and that its context applied', () => {
    const markdown = briefToMarkdown({
      ...base,
      clientContext: {
        clientId: 'c-1',
        clientName: 'Anduril',
        status: 'applied',
        relevanceBand: 'HIGH',
      },
    });
    expect(markdown).toContain('_Prepared for Anduril · client priorities applied_');
  });

  test('is honest in the filed document when no client context was available', () => {
    const markdown = briefToMarkdown({
      ...base,
      clientContext: {
        clientId: 'c-1',
        clientName: null,
        status: 'unavailable',
        relevanceBand: null,
      },
    });
    expect(markdown).toContain(
      '_Prepared for the selected client · no client-specific context was available — read as a general recap_',
    );
  });

  test('writes no client line for a client-agnostic brief, including one from an older intel-api', () => {
    expect(briefToMarkdown(base)).not.toContain('Prepared for');
    expect(
      briefToMarkdown({
        ...base,
        clientContext: { clientId: null, clientName: null, status: 'none', relevanceBand: null },
      }),
    ).not.toContain('Prepared for');
  });
});

describe('useGenerateBrief', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: null });
  });

  test('asks intel-api for the brief written FOR the chosen client', async () => {
    const { result } = renderHook(() => useGenerateBrief(), { wrapper: withQueryClient() });
    result.current.mutate({ sessionId: 'session-1', clientId: 'client-9' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(apiGet.mock.calls[0]![0]).toBe('/intel-api/hearings/session-1/brief?clientId=client-9');
  });

  test('uses the AI-generation timeout, not the tight 30s default (real synthesis runs 34–69s)', async () => {
    const { result } = renderHook(() => useGenerateBrief(), { wrapper: withQueryClient() });
    result.current.mutate({ sessionId: 'session-1', clientId: 'client-9' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    // The brief URL does not match GENERATION_URL_PATTERNS, so the explicit
    // per-request timeout is what keeps a real synthesis from aborting at 30s.
    expect(apiGet.mock.calls[0]![1]).toEqual({ timeout: 175_000 });
  });

  test('omits the client parameter when no client is given (client-agnostic brief)', async () => {
    const { result } = renderHook(() => useGenerateBrief(), { wrapper: withQueryClient() });
    result.current.mutate({ sessionId: 'session-1' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(apiGet.mock.calls[0]![0]).toBe('/intel-api/hearings/session-1/brief');
  });
});

describe('useSaveRecap', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({
      data: {
        sessionId: 'session-1',
        title: 'r',
        document: { attachmentId: 'att-1', fileName: 'r.docx' },
      },
    });
  });

  test('files a recap through the dedicated hearing-recap endpoint without a browser-owned client name', async () => {
    const { result } = renderHook(() => useSaveRecap(), { wrapper: withQueryClient() });
    result.current.mutate({
      sessionId: 'session-1',
      clientId: 'client-9',
      title: 'Hearing recap — Armed Services',
      markdown: '# recap',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = apiPost.mock.calls[0]!;
    // alert-memo/save requires an alertId and carries alert-memo governance, so
    // every hearing recap sent there was rejected by the global ValidationPipe.
    expect(url).toBe('/api/intelligence/clients/client-9/hearing-recaps');
    expect(url).not.toContain('alert-memo');
    expect(body).toEqual({
      sessionId: 'session-1',
      title: 'Hearing recap — Armed Services',
      markdown: '# recap',
    });
    expect(body).not.toHaveProperty('clientName');
  });
});

describe('useCurrentHearingRecap', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  test('uses the exact sessionId filter (single bounded query), not a page scan', async () => {
    apiGet.mockResolvedValue({
      data: {
        items: [
          {
            id: 'att-400-plus',
            fileName: 'Old.docx',
            indexedAt: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            sessionId: 'session-9',
            sessionTitle: 'Old hearing',
            sourceType: 'hearing',
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
    });
    const { result } = renderHook(() => useCurrentHearingRecap('client-9', 'session-9'), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.data?.id).toBe('att-400-plus'));
    // One filtered request naming the session — an old recap beyond any client
    // scan window is still found because the SERVER filters by sessionId.
    expect(apiGet).toHaveBeenCalledTimes(1);
    const url = apiGet.mock.calls[0]![0] as string;
    expect(url).toContain('/api/intelligence/clients/client-9/hearing-recaps?');
    expect(url).toContain('sessionId=session-9');
    expect(url).toContain('limit=1');
  });

  test('returns null when the client has no recap for this session', async () => {
    apiGet.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });
    const { result } = renderHook(() => useCurrentHearingRecap('client-9', 'session-9'), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useHearingTranscript', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  test('reads a bounded page of persisted transcript and follows nextOffset', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('offset=0')
        ? {
            data: {
              items: [{ id: 'a', startMs: 0, endMs: 1, text: 'one' }],
              nextOffset: 500,
              hasMore: true,
            },
          }
        : {
            data: {
              items: [{ id: 'b', startMs: 2, endMs: 3, text: 'two' }],
              nextOffset: null,
              hasMore: false,
            },
          },
    );

    const { result } = renderHook(() => useHearingTranscript('session-1'), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledWith(
      '/intel-api/hearings/session-1/transcript?offset=0&limit=500',
    );
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(apiGet).toHaveBeenLastCalledWith(
      '/intel-api/hearings/session-1/transcript?offset=500&limit=500',
    );
    expect(result.current.hasNextPage).toBe(false);
  });
});
