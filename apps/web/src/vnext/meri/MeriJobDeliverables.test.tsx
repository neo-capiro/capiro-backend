import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
import { MeriJobDeliverables } from './MeriJobDeliverables.js';

const authHeaders = async () => ({ Authorization: 'Bearer token' });
const job = (overrides: Record<string, unknown> = {}) => ({
  kind: 'deliverable',
  status: 'completed',
  goalRevision: 0,
  deliverables: [{ format: 'docx', title: 'HR 1 office brief', artifactId: null }],
  awaitingStart: false,
  ...overrides,
});

function stubFetch(session: unknown, file?: { status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/file'))
        return new Response(JSON.stringify(file?.body ?? {}), { status: file?.status ?? 200 });
      if (/\/(docx|xlsx|pptx)$/.test(url))
        return new Response(new Blob(['office']), {
          status: 200,
          headers: { 'Content-Disposition': "attachment; filename*=UTF-8''HR%201%20office%20brief.docx" },
        });
      return new Response(JSON.stringify(session), { status: 200 });
    }),
  );
  return calls;
}

async function mount() {
  await act(async () => {
    render(<MeriJobDeliverables researchId="job-1" authHeaders={authHeaders} refreshKey="complete" />);
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:docx');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deliverable job card', () => {
  test.each([
    ['a research session', { job: job({ kind: 'research', deliverables: [] }) }],
    ['a running deliverable job', { job: job({ status: 'executing' }) }],
    ['an older API shape without a job', {}],
  ])('stays hidden for %s', async (_label, session) => {
    stubFetch(session);
    await mount();
    expect(screen.queryByRole('region', { name: 'Job deliverables' })).toBeNull();
  });

  test('downloads the Word document rendered by the API', async () => {
    const calls = stubFetch({ job: job() });
    await mount();
    await waitFor(() => expect(screen.getByText(/HR 1 office brief/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    expect(calls.some((call) => call.url.endsWith('/research/job-1/deliverables/0/docx'))).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  test.each([
    ['xlsx', 'Excel workbook'],
    ['pptx', 'PowerPoint deck'],
  ] as const)('downloads a %s deliverable from its own path and labels it', async (format, label) => {
    const calls = stubFetch({
      job: job({ deliverables: [{ format, title: 'FY27 marks', artifactId: null }] }),
    });
    await mount();
    await waitFor(() => expect(screen.getByText(`(${label})`)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    expect(calls.some((call) => call.url.endsWith(`/research/job-1/deliverables/0/${format}`))).toBe(
      true,
    );
    expect(calls.some((call) => call.url.endsWith('/docx'))).toBe(false);
  });

  test('offers no download for a format the API does not render', async () => {
    stubFetch({ job: job({ deliverables: [{ format: 'pdf', title: 'Brief', artifactId: null }] }) });
    await mount();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Job deliverables' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  test('files once on confirmation and links to the client Files', async () => {
    const calls = stubFetch(
      { job: job() },
      { status: 200, body: { status: 'saved', location: '/clients?clientId=c1&tab=files&attachmentId=d1' } },
    );
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'File to client folder' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File to client folder' }));
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const link = await screen.findByRole('link', { name: 'Open in client Files' });
    expect(link.getAttribute('href')).toBe('/clients?clientId=c1&tab=files&attachmentId=d1');
  });

  test('shows an already filed deliverable and reports a refused filing', async () => {
    stubFetch({ job: job({ deliverables: [{ format: 'docx', title: 'Brief', artifactId: 'd1' }] }) }, { status: 403 });
    await mount();
    const button = await screen.findByRole('button', { name: 'Filed — open in client Files' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not enabled/);
  });
});
