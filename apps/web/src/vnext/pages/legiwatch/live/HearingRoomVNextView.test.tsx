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
});
