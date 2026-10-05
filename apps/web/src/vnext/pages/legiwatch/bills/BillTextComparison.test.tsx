import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-one' }));
import { BillTextComparison } from './BillTextComparison.js';

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const version = (id: string, complete = true) => ({ id, revision: 'revision-' + id, title: 'Text ' + id, kind: 'text', complete, publishedDate: '2026-03-01' });
function show() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BillTextComparison billId="fl-2026-h1211" /></QueryClientProvider>);
}
describe('state bill text comparison', () => {
  it('compares explicitly selected exact revisions and renders added/removed wording', async () => {
    mocks.get.mockResolvedValue({ data: { versions: [version('a'), version('b')], complete: true } });
    mocks.post.mockResolvedValue({ data: { changes: [
      { kind: 'removed', text: 'Old provision', left: { locator: 'Section 1' }, right: null },
      { kind: 'added', text: 'New provision', left: null, right: { locator: 'Section 1' } },
    ] } });
    show();
    fireEvent.change(await screen.findByLabelText('Earlier text'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Later text'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected text' }));
    await screen.findByText('New provision');
    expect(mocks.post).toHaveBeenCalledWith('/intel-api/legiwatch/research/compare', {
      jurisdiction: 'FL', sessionKey: '2026', leftId: 'a', rightId: 'b', leftRevision: 'revision-a', rightRevision: 'revision-b',
    });
    expect(screen.getByText('Old provision').tagName).toBe('DEL');
    expect(screen.getByText('New provision').tagName).toBe('INS');
    fireEvent.change(screen.getByLabelText('Later text'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.queryByText('New provision')).toBeNull());
  });
  it('does not offer a diff against incomplete extractions', async () => {
    mocks.get.mockResolvedValue({ data: { versions: [version('a'), version('b', false)], complete: true } });
    show();
    await screen.findByText(/Two complete text versions are needed/);
    expect(screen.queryByRole('button', { name: 'Compare selected text' })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
