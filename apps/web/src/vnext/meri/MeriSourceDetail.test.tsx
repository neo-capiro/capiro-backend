import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeriSourceDetail } from './MeriSourceDetail.js';
import { readMeriSource } from './meri-source-api.js';
import type { MeriCitation } from '../../components/chat/chat-store.js';
vi.mock('./meri-source-api.js', async (load) => ({ ...await load<typeof import('./meri-source-api.js')>(), readMeriSource: vi.fn() }));
const first = '50000000-0000-4000-8000-000000000001';
const second = '50000000-0000-4000-8000-000000000002';
const client = '30000000-0000-4000-8000-000000000001';
const citations: MeriCitation[] = [{ n: 1, id: first, title: 'Advocacy letter', type: 'email', snippet: 'Original saved excerpt.', url: null, tool: 'get_email_thread' },
  { n: 2, id: second, title: 'Profile', type: 'client', snippet: 'Original profile excerpt.', url: null, tool: 'get_client_context', source: { kind: 'client', recordId: client } }];
const props = { citations, initialIndex: 0, scopeLabel: 'Sightline', onClose: vi.fn(), getAuthHeaders: async () => ({ Authorization: 'Bearer test' }) };
beforeEach(() => vi.mocked(readMeriSource).mockReset());

describe('full source panel', () => {
  it('loads full message continuation, preserves original excerpt and displays exact sender/date/IDs', async () => {
    vi.mocked(readMeriSource).mockResolvedValueOnce({ kind: 'email', status: 'available', recordId: first, versionStatus: 'current_version_only', totalMessages: 1, nextCursor: 'page2',
      message: { id: first, threadId: second, subject: 'UH-72 LUT', from: { email: 'tom@example.test', name: 'Tom' }, to: [], cc: [], sentAt: '2026-09-02T12:00:00Z', receivedAt: '2026-09-02T12:01:00Z', bodyText: 'A'.repeat(6000), offset: 0, endOffset: 6000, bodyLength: 6040, bodyCompleteness: 'full', messageNumber: 1 } });
    vi.mocked(readMeriSource).mockResolvedValueOnce({ kind: 'email', status: 'available', recordId: first, nextCursor: null,
      message: { id: first, threadId: second, subject: 'UH-72 LUT', from: { email: 'tom@example.test' }, to: [], cc: [], bodyText: 'FINAL CHECKSUM $7.5M REQUEST ONLY', offset: 6000, endOffset: 6040, bodyLength: 6040, bodyCompleteness: 'full', messageNumber: 1 } });
    render(<MeriSourceDetail {...props} />);
    expect(await screen.findByText(/Tom · tom@example.test/)).toBeTruthy();
    expect(screen.getByText(/2026-09-02T12:00:00Z/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Message ID: ${first}`))).toBeTruthy();
    expect(screen.getByText('Original saved excerpt.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read more source content' }));
    expect(await screen.findByText('FINAL CHECKSUM $7.5M REQUEST ONLY')).toBeTruthy();
    expect(readMeriSource).toHaveBeenLastCalledWith({ kind: 'email', recordId: first }, props.getAuthHeaders, 'page2', expect.any(AbortSignal));
    expect(screen.getByText('End of the currently available source content.')).toBeTruthy();
  });
  it.each(['text_readable', 'ocr_readable'])('does not warn about unreadable content for canonical %s success', async (status) => {
    vi.mocked(readMeriSource).mockResolvedValue({ kind: 'document', status: 'available', recordId: first, text: 'Readable full content.', readability: { status }, nextCursor: null });
    render(<MeriSourceDetail {...props} />);
    expect(await screen.findByText('Readable full content.')).toBeTruthy();
    expect(screen.queryByText(/Some source content may be unreadable/)).toBeNull();
  });
  it('shows partial OCR details and changed-source status', async () => {
    vi.mocked(readMeriSource).mockResolvedValue({ kind: 'document', status: 'available', recordId: first, text: 'Some readable text.', versionStatus: 'changed_since_citation', truncated: true, readability: { status: 'ocr_partial', note: 'Page 2 could not be read.' } });
    render(<MeriSourceDetail {...props} />);
    expect(await screen.findByText(/Page 2 could not be read/)).toBeTruthy();
    expect(screen.getByText(/This source changed after the answer/)).toBeTruthy();
  });
  it('preserves historical scope, supports Previous/Next/Back, and opens the canonical full profile', async () => {
    vi.mocked(readMeriSource).mockResolvedValue({ kind: 'client', status: 'record_navigation', recordId: client, title: 'Sightline', location: `/clients?clientId=${client}` });
    const onIndexChange = vi.fn(); render(<MeriSourceDetail {...props} onIndexChange={onIndexChange} />);
    await waitFor(() => expect(readMeriSource).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Next source' }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
    expect(await screen.findByRole('link', { name: 'OPEN SOURCE' })).toHaveAttribute('href', `/clients?clientId=${client}`);
    expect(screen.getByText('Sightline')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Previous source' })));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: 'BACK TO CONTEXT' }));
    expect(props.onClose).toHaveBeenCalled();
  });
  it('discards an old source response after Next and keeps a recoverable error', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(readMeriSource).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; })).mockRejectedValueOnce(new Error('Access to this source is denied.'));
    render(<MeriSourceDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('denied');
    await act(async () => resolve({ kind: 'email', status: 'available', recordId: first, text: 'STALE RESPONSE' }));
    expect(screen.queryByText('STALE RESPONSE')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart source read' })).toBeTruthy();
  });
  it('makes an unsupported citation explicit without inventing a source reader', () => {
    render(<MeriSourceDetail {...props} citations={[{ ...citations[0]!, id: 'aggregate:record', tool: 'unknown', type: 'aggregate' }]} />);
    expect(screen.getByText(/complete-source reader is not available/)).toBeTruthy();
    expect(readMeriSource).not.toHaveBeenCalled();
  });
});
