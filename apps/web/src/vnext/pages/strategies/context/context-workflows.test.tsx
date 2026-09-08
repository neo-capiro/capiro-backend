import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { setGlobalClientFilter } from '../../../../state/client-filter.js';
import { ContextReadingView, readableContextBody } from './ContextReadingView.js';
import { useContextClientScope } from './use-context-client-scope.js';
import { contextHealthStatus } from './context-health-label.js';
import { useContextDocuments, useContextFacts, useContextConflicts } from '../strategies-api.js';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));

function ScopeDataHarness() {
  const scope = useContextClientScope();
  const firmOnly = scope.scope === 'firm';
  const documents = useContextDocuments(scope.clientId ?? undefined, firmOnly);
  const facts = useContextFacts({ clientId: scope.clientId ?? undefined, includeFirm: true, firmOnly });
  const conflicts = useContextConflicts(scope.clientId ?? undefined, firmOnly);
  return <><button onClick={() => scope.select('firm')}>Firm</button><button onClick={() => scope.select('all')}>All</button>
    {[['documents', documents.data], ['facts', facts.data], ['conflicts', conflicts.data]].map(([name, rows]) =>
      <output key={name as string} data-testid={name as string}>{(rows as Array<{ id: string }> | undefined)?.map((row) => row.id).join(',')}</output>)}
  </>;
}

function ScopeHarness() {
  const scope = useContextClientScope(); const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="scope">{scope.scope}</output><output data-testid="url">{location.search}</output>
    <button onClick={() => scope.select('client-b')}>Choose B</button>
    <button onClick={() => navigate('?clientId=client-a')}>Linked A</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </>;
}
beforeEach(() => setGlobalClientFilter(null));
describe('Context scope and reading', () => {
  it('fetches firm-only documents, facts and conflicts without reusing cached all-client results', async () => {
    api.get.mockImplementation(async (url: string) => {
      const query = new URL(url, 'https://example.test').searchParams;
      return { data: [{ id: query.get('firmOnly') === 'true' ? 'firm-result' : 'all-result', fact: 'Evidence' }] };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><ScopeDataHarness /></MemoryRouter></QueryClientProvider>);
    for (const kind of ['documents', 'facts', 'conflicts']) await waitFor(() => expect(screen.getByTestId(kind)).toHaveTextContent('all-result'));
    fireEvent.click(screen.getByRole('button', { name: 'Firm' }));
    for (const kind of ['documents', 'facts', 'conflicts']) await waitFor(() => expect(screen.getByTestId(kind)).toHaveTextContent('firm-result'));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    for (const kind of ['documents', 'facts', 'conflicts']) expect(screen.getByTestId(kind)).toHaveTextContent('all-result');
    client.clear();
  });
  it('restores URL scope, follows shell switches, and preserves back navigation', async () => {
    render(<MemoryRouter initialEntries={['/strategies/context?clientId=client-a']}><ScopeHarness /></MemoryRouter>);
    expect(screen.getByTestId('scope')).toHaveTextContent('client-a');
    act(() => setGlobalClientFilter('client-b'));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('clientId=client-b'));
    fireEvent.click(screen.getByText('Linked A'));
    await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('client-a'));
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('client-b'));
  });
  it('formats headings and tables while retaining exact source line highlights and suppressing executable content', () => {
    const content = '---\nauthority: working_draft\n---\n# Goal\n\nProtect the program.\n\n| Ask | FY |\n| --- | --- |\n| 14M | 2027 |\n\n<script>window.attacked=true</script>\n[bad](javascript:alert(1))';
    expect(readableContextBody(content).offset).toBe(3);
    const { container } = render(<ContextReadingView content={content} highlight={{ start: 4, end: 4 }} />);
    expect(screen.getByRole('heading', { name: 'Goal' })).toHaveAttribute('data-source-line', '4');
    expect(screen.getByRole('heading', { name: 'Goal' })).toHaveClass('is-hit');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('authority: working_draft')).not.toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
  it('separates missing, unassessed, stale, conflicted and unavailable health', () => {
    const health = { status: 'ok' as const, missingRequired: [], staleDocuments: 0, openMaterialConflicts: [] };
    expect(contextHealthStatus(health, false, false, 0).label).toMatch(/Not assessed/);
    expect(contextHealthStatus({ ...health, missingRequired: ['brief'] }, false, false, 0).label).toMatch(/Missing/);
    expect(contextHealthStatus({ ...health, staleDocuments: 1 }, false, false, 1).label).toMatch(/updating/);
    expect(contextHealthStatus({ ...health, status: 'conflicted' }, false, false, 1).label).toMatch(/Conflicting/);
    expect(contextHealthStatus(health, true, false, 1).label).toMatch(/unavailable/);
  });
  it('hides valid frontmatter with whitespace fences and preserves CRLF citation coordinates', () => {
    const content = '---  \r\nauthority: working_draft\r\n---\t\r\n# Goal\r\n\r\nSource text';
    expect(readableContextBody(content)).toEqual({ body: '# Goal\n\nSource text', offset: 3 });
    render(<ContextReadingView content={content} highlight={{ start: 4, end: 4 }} />);
    expect(screen.getByRole('heading', { name: 'Goal' })).toHaveClass('is-hit');
    expect(screen.queryByText(/authority:/)).not.toBeInTheDocument();
  });
});
