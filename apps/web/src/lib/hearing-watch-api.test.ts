import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('./use-api.js', () => ({ useApi: () => ({ get: apiGet, post: apiPost }) }));

const { briefToMarkdown, isMediaUrl, mediaKindOf, useHearingTranscript, useSaveRecap } =
  await import('./hearing-watch-api.js');

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
  test('preserves transcript segment and timestamp anchors in the client deliverable', () => {
    const markdown = briefToMarkdown({
      sessionId: 'session-1',
      title: 'House Armed Services hearing',
      generatedAt: '2026-07-28T16:00:00.000Z',
      executiveSummary: 'The committee discussed acquisition reform.',
      keyMoments: [
        {
          segmentId: 'segment-7',
          timestampMs: 125_000,
          speakerName: 'Chair Smith',
          text: 'We need a faster acquisition process.',
        },
      ],
      relevantQuotes: [],
      supporters: [],
      opponents: [],
      tone: 'constructive',
      risks: [],
      opportunities: [],
      recommendedNextSteps: ['Follow up with committee staff.'],
      draftClientEmail: { subject: 'Update', body: 'Body' },
      claimMap: [{ claimId: 'claim-1', segmentId: 'segment-7', timestampMs: 125_000 }],
      synthesisSource: 'orchestrator',
    });

    expect(markdown).toContain('[segment:segment-7]');
    expect(markdown).toContain('[claim-1] segment segment-7 at 2:05');
    expect(markdown).toContain('Follow up with committee staff.');
  });
});

describe('useSaveRecap', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({
      data: { sessionId: 'session-1', title: 'r', document: { attachmentId: 'att-1', fileName: 'r.docx' } },
    });
  });

  test('files a recap through the dedicated hearing-recap endpoint, not alert-memo/save', async () => {
    const { result } = renderHook(() => useSaveRecap(), { wrapper: withQueryClient() });
    result.current.mutate({
      sessionId: 'session-1',
      clientId: 'client-9',
      clientName: 'Acme Defense',
      title: 'Hearing recap — Armed Services',
      markdown: '# recap',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = apiPost.mock.calls[0]!;
    // alert-memo/save requires an alertId and carries alert-memo governance, so
    // every hearing recap sent there was rejected by the global ValidationPipe.
    expect(url).toBe('/api/intelligence/clients/client-9/hearing-recaps');
    expect(url).not.toContain('alert-memo');
    expect(body).toEqual(
      expect.objectContaining({ sessionId: 'session-1', clientName: 'Acme Defense', markdown: '# recap' }),
    );
  });
});

describe('useHearingTranscript', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  test('reads a bounded page of persisted transcript and follows nextOffset', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.includes('offset=0')
        ? { data: { items: [{ id: 'a', startMs: 0, endMs: 1, text: 'one' }], nextOffset: 500, hasMore: true } }
        : { data: { items: [{ id: 'b', startMs: 2, endMs: 3, text: 'two' }], nextOffset: null, hasMore: false } },
    );

    const { result } = renderHook(() => useHearingTranscript('session-1'), {
      wrapper: withQueryClient(),
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledWith('/intel-api/hearings/session-1/transcript?offset=0&limit=500');
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(apiGet).toHaveBeenLastCalledWith(
      '/intel-api/hearings/session-1/transcript?offset=500&limit=500',
    );
    expect(result.current.hasNextPage).toBe(false);
  });
});
