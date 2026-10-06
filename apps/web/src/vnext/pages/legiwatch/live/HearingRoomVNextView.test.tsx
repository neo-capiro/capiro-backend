import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { HearingRoomViewModel } from '../../../../pages/intelligence/LiveHearingRoomPage.js';
import { HearingRoomVNextView } from './HearingRoomVNextView.js';

function model(overrides: Partial<HearingRoomViewModel> = {}): HearingRoomViewModel {
  return {
    session: { id: 'session', title: 'Committee hearing', status: 'live', sourceType: 'committee', audioSource: 'browser_tab' },
    loading: false, unavailable: false, phase: 'connected', captureActive: false, sessionEnded: false,
    segments: [
      { id: 'a', startMs: 1_000, endMs: 3_000, text: 'Opening testimony', speakerLabel: 'Chair' },
      { id: 'b', startMs: 14_399_000, endMs: 14_400_000, text: 'Robotics funding commitment', speakerLabel: 'Witness' },
    ],
    interim: '', cards: [{ id: 'match', cardType: 'watchlist_match', title: 'Robotics opportunity', startMs: 14_399_000 }],
    transcriptLoading: false, transcriptError: false, intelligenceError: false, error: null, statusText: null,
    bytesSent: 0, lastTranscriptAt: null, wakeLock: 'inactive', sourcePlayer: <video controls aria-label="Source playback" />,
    retry: vi.fn(), dismissError: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), startCapture: vi.fn(),
    endSession: vi.fn(), goBack: vi.fn(), confirmConsent: vi.fn(), confirmingConsent: false, saveRecap: vi.fn(),
    ...overrides,
  };
}

describe('native vNext hearing room', () => {
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

  test('searches testimony and speaker, filters real matches, and jumps from intelligence to its evidence', () => {
    render(<HearingRoomVNextView room={model()} />);
    const transcript = screen.getByRole('region', { name: 'Live transcript' });
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'opening' } });
    expect(within(transcript).getByText('Opening testimony')).toBeInTheDocument();
    expect(within(transcript).queryByText('Robotics funding commitment')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Jump to 03:59:59/ }));
    expect(screen.getByLabelText('Search transcript')).toHaveValue('');
    expect(transcript.querySelector('[data-segment-id="b"]')).toHaveClass('is-selected');
    const jumps = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Jump to 03:59:59/ }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(jumps + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Matched only' }));
    expect(within(transcript).queryByText('Opening testimony')).not.toBeInTheDocument();
    expect(within(transcript).getByText('Robotics funding commitment')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to live' }));
    fireEvent.change(screen.getByLabelText('Speaker'), { target: { value: 'Chair' } });
    expect(within(transcript).queryByText('Robotics funding commitment')).not.toBeInTheDocument();
    expect(within(transcript).getByText('Opening testimony')).toBeInTheDocument();
  });

  test('keeps transcript review independent of capture and wires consent, stop and recap', () => {
    const room = model({ phase: 'capturing', captureActive: true,
      session: { ...model().session!, consentStatus: 'needs_review' } });
    const { rerender } = render(<HearingRoomVNextView room={room} />);
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'opening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Matched only' }));
    expect(room.endSession).not.toHaveBeenCalled();
    expect(room.startCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm consent' }));
    expect(room.confirmConsent).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Stop capture' }));
    expect(room.endSession).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Save recap' })).toBeDisabled();
    rerender(<HearingRoomVNextView room={{ ...room, phase: 'ended', captureActive: false, sessionEnded: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save recap' }));
    expect(room.saveRecap).toHaveBeenCalledOnce();
  });

  test('does not infer active browser recording from the saved session live status', () => {
    render(<HearingRoomVNextView room={model({ phase: 'idle', segments: [], cards: [] })} />);
    expect(screen.getByText('NOT CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('STOPPED')).toBeInTheDocument();
    expect(screen.queryByText('STREAMING')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start transcription' })).toBeDisabled();
  });

  test('retains testimony and native panel geometry when refresh fails', () => {
    const room = model({ transcriptError: true, intelligenceError: true });
    const { container } = render(<HearingRoomVNextView room={room} />);
    expect(screen.getByText('Opening testimony')).toBeInTheDocument();
    expect(container.querySelector('.lw-live__transcript')).toBeInTheDocument();
    expect(container.querySelector('.lw-video video[controls]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry transcript' }));
    expect(room.retry).toHaveBeenCalledOnce();
  });

  test('searches the end of a four-hour transcript without mounting every row', () => {
    const segments = Array.from({ length: 14_400 }, (_, index) => ({
      id: `s-${index}`, startMs: index * 1_000, endMs: (index + 1) * 1_000, text: `Testimony segment ${index}`,
    }));
    const { container } = render(<HearingRoomVNextView room={model({ segments })} />);
    expect(container.querySelectorAll('[data-segment-id]').length).toBeLessThan(100);
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'Testimony segment 14399' } });
    expect(screen.getByText('Testimony segment 14399')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Live transcript' })).getByText('03:59:59')).toBeInTheDocument();
  });

  test('renders canonical empty state for public review sessions', () => {
    render(
      <HearingRoomVNextView
        room={model({
          session: {
            id: 'session',
            title: 'Public review hearing',
            status: 'ended',
            sourceType: 'hearing',
            audioSource: 'browser_tab',
            publicCaptureId: 'capture-1',
          },
          segments: [],
        })}
      />,
    );
    expect(
      screen.getByText('No canonical transcript segments are saved for this hearing yet.'),
    ).toBeInTheDocument();
  });

  test('public review shows the real public source and omits impossible browser controls', () => {
    const room = model({
      phase: 'idle',
      sessionEnded: true,
      session: {
        id: 'session',
        title: 'Public review hearing',
        status: 'ended',
        sourceType: 'hearing',
        audioSource: 'stream_url',
        sourceUrl: 'https://committee.example/hearings/42',
        publicCaptureId: 'capture-1',
        hearingId: 'hearing-1',
      },
      segments: [],
      cards: [],
    });
    render(<HearingRoomVNextView room={room} />);
    // Real source semantics, not the browser-tab fiction.
    expect(screen.getByText('STREAM URL')).toBeInTheDocument();
    expect(screen.queryByText('BROWSER TAB')).not.toBeInTheDocument();
    expect(screen.getByText('Public capture')).toBeInTheDocument();
    expect(screen.queryByText('Browser recording')).not.toBeInTheDocument();
    // No impossible browser-capture affordances in public review.
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start transcription' })).not.toBeInTheDocument();
    expect(screen.queryByText('Keep recording')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sent \d/)).not.toBeInTheDocument();
    // Real public abilities stay: source link, saved-audio link, saved transcript.
    expect(
      screen.getByRole('link', { name: 'Open hearing source ↗' }),
    ).toHaveAttribute('href', 'https://committee.example/hearings/42');
    expect(screen.getByRole('link', { name: 'Review hearing and audio availability ↗' })).toHaveAttribute(
      'href',
      '/legiwatch/hearings/hearing-1',
    );
    expect(screen.getByText('ENDED')).toBeInTheDocument();
    // Video footer names the real transcription source, not the browser tab.
    expect(
      screen.getByText(/Transcription comes from the shared public capture\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/shared tab’s audio/)).not.toBeInTheDocument();
  });

  test('public review play-evidence drives the shared player callback', () => {
    const playEvidence = vi.fn();
    render(
      <HearingRoomVNextView
        room={model({
          playEvidence,
          canPlayEvidence: (ms) => ms === 1000,
          recordingPanel: <section aria-label="Saved unattended audio" />,
          session: {
            id: 'session',
            title: 'Public review hearing',
            status: 'ended',
            sourceType: 'hearing',
            audioSource: 'stream_url',
            publicCaptureId: 'capture-1',
            hearingId: 'hearing-1',
          },
        })}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Play audio here' });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(playEvidence).toHaveBeenCalledWith(1_000);
  });

  test('a completed transcript without retained coverage has no playback actions', () => {
    render(<HearingRoomVNextView room={model({ playEvidence: vi.fn(), canPlayEvidence: () => false, recordingPanel: <section aria-label="Saved unattended audio" /> })} />);
    expect(screen.queryByRole('button', { name: 'Play audio here' })).not.toBeInTheDocument();
  });

  // Adjacent-segment boundary semantics. A cited moment at the exact ms where
  // one segment ends and the next begins belongs to the segment that STARTS
  // there. Generic ids only — no fixture-specific identifiers.
  describe('shared-boundary jump and match semantics', () => {
    // Three contiguous segments: [0,100) [100,200) [200,300).
    const segments = [
      { id: 'seg-first', startMs: 0, endMs: 100, text: 'First passage', speakerLabel: 'A' },
      { id: 'seg-boundary', startMs: 100, endMs: 200, text: 'Boundary passage', speakerLabel: 'A' },
      { id: 'seg-third', startMs: 200, endMs: 300, text: 'Third passage', speakerLabel: 'A' },
    ];
    const selected = () =>
      document.querySelector('[data-segment-id].is-selected')?.getAttribute('data-segment-id');
    const jump = (title: string, clockLabel: string) =>
      screen.getByRole('button', { name: `Jump to ${clockLabel}: ${title}` });

    test('jump at an exact shared endpoint selects the segment that starts there, not the one that ends there', () => {
      const room = model({
        segments,
        cards: [{ id: 'c1', cardType: 'watchlist_match', title: 'Boundary moment', startMs: 100 }],
      });
      render(<HearingRoomVNextView room={room} />);
      fireEvent.click(jump('Boundary moment', '00:00:00'));
      expect(selected()).toBe('seg-boundary');
    });

    test('the cited segment id, when the card carries one, is the authoritative target', () => {
      const room = model({
        segments,
        cards: [
          {
            id: 'c1',
            cardType: 'watchlist_match',
            title: 'Cited moment',
            startMs: 100,
            segmentId: 'seg-boundary',
          },
        ],
      });
      render(<HearingRoomVNextView room={room} />);
      fireEvent.click(jump('Cited moment', '00:00:00'));
      expect(selected()).toBe('seg-boundary');
    });

    test('an interior timestamp selects the containing segment', () => {
      const room = model({
        segments,
        cards: [{ id: 'c1', cardType: 'watchlist_match', title: 'Interior moment', startMs: 150 }],
      });
      render(<HearingRoomVNextView room={room} />);
      fireEvent.click(jump('Interior moment', '00:00:00'));
      expect(selected()).toBe('seg-boundary');
    });

    test('a timestamp before any segment selects the nearest later segment; past the end selects the final segment', () => {
      // Gap before seg-boundary: 50 has no containing interval, lands on next.
      const gapped = [
        { id: 'seg-first', startMs: 0, endMs: 40, text: 'First passage', speakerLabel: 'A' },
        { id: 'seg-boundary', startMs: 100, endMs: 200, text: 'Boundary passage', speakerLabel: 'A' },
      ];
      const { unmount } = render(
        <HearingRoomVNextView
          room={model({
            segments: gapped,
            cards: [{ id: 'c1', cardType: 'watchlist_match', title: 'Gap moment', startMs: 50 }],
          })}
        />,
      );
      fireEvent.click(jump('Gap moment', '00:00:00'));
      expect(selected()).toBe('seg-boundary');
      unmount();
      // Past the last segment's end: final-segment fallback.
      render(
        <HearingRoomVNextView
          room={model({
            segments: gapped,
            cards: [{ id: 'c2', cardType: 'watchlist_match', title: 'Late moment', startMs: 999 }],
          })}
        />,
      );
      fireEvent.click(jump('Late moment', '00:00:00'));
      expect(selected()).toBe('seg-boundary');
    });

    test('a match at a shared boundary marks only the starting segment and Matched only filters to it', () => {
      const room = model({
        segments,
        cards: [{ id: 'c1', cardType: 'watchlist_match', title: 'Boundary match', startMs: 100 }],
      });
      render(<HearingRoomVNextView room={room} />);
      const transcript = screen.getByRole('region', { name: 'Live transcript' });
      // MATCH pill on the starting segment only, never the prior one.
      expect(
        transcript.querySelector('[data-segment-id="seg-boundary"]'),
      ).toHaveClass('is-match');
      expect(
        transcript.querySelector('[data-segment-id="seg-first"]'),
      ).not.toHaveClass('is-match');
      expect(
        transcript.querySelector('[data-segment-id="seg-third"]'),
      ).not.toHaveClass('is-match');
      // Matched only keeps the starting segment and drops the prior one.
      fireEvent.click(screen.getByRole('button', { name: 'Matched only' }));
      expect(within(transcript).getByText('Boundary passage')).toBeInTheDocument();
      expect(within(transcript).queryByText('First passage')).not.toBeInTheDocument();
      expect(within(transcript).queryByText('Third passage')).not.toBeInTheDocument();
    });

    test('a zero timestamp selects the first segment', () => {
      const room = model({
        segments,
        cards: [{ id: 'c1', cardType: 'watchlist_match', title: 'Opening moment', startMs: 0 }],
      });
      render(<HearingRoomVNextView room={room} />);
      fireEvent.click(jump('Opening moment', '00:00:00'));
      expect(selected()).toBe('seg-first');
    });
  });
});
