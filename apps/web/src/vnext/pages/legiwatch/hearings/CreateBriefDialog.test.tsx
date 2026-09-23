/**
 * CreateBriefDialog — the real dialog against a stubbed `useApi`: Meri drafts
 * server-side, the user refines through the REAL Workspace assistant hook (its
 * edits applied by the editor's own reducer, with undo), and nothing is ever
 * saved on failure.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

interface Call {
  method: 'get' | 'post' | 'patch';
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
const handlers = {
  get: vi.fn<(url: string) => unknown>(),
  post: vi.fn<(url: string, body?: unknown) => unknown>(),
  patch: vi.fn<(url: string, body?: unknown) => unknown>(),
};
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return { data: await handlers.get(url) };
    },
    post: async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: await handlers.post(url, body) };
    },
    patch: async (url: string, body?: unknown) => {
      calls.push({ method: 'patch', url, body });
      return { data: await handlers.patch(url, body) };
    },
  }),
}));

import { CreateBriefDialog } from './CreateBriefDialog.js';

const HEARING_ID = 'cm-119-9001';
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENTS = [
  { id: CLIENT_A, name: 'Aperture Defense', status: 'active' },
  { id: 'client-archived', name: 'Old Holdings', status: 'archived' },
];
const GENERATE_URL = `/api/legiwatch/live-hearings/events/${HEARING_ID}/actions/brief/generate`;
const BRIEF = {
  title: 'Hearing brief — Shipbuilding',
  mode: 'recap',
  sections: [
    {
      name: 'Executive summary',
      content: 'The chair tied **multiyear** funding to workforce stability.',
    },
    { name: 'Key exchanges', content: '- Funding stability matters\n- Watch the markup' },
  ],
  keyMoments: [{ startMs: 65_000, speaker: 'CHAIR', summary: 'Multiyear procurement.' }],
  sources: [{ kind: 'hearing', id: HEARING_ID }],
  contextPacket: { hearing: { id: HEARING_ID } },
  lowConfidence: false,
};

function renderDialog(props: Partial<Parameters<typeof CreateBriefDialog>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <CreateBriefDialog
        hearingId={HEARING_ID}
        hearingTitle="Shipbuilding"
        initialClientId={CLIENT_A}
        hasTranscript
        onClose={onClose}
        onSaved={onSaved}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

async function generate() {
  await screen.findByRole('option', { name: 'Aperture Defense' });
  fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));
  await screen.findByText('Executive summary');
}

beforeEach(() => {
  calls.length = 0;
  handlers.get.mockReset();
  handlers.post.mockReset();
  handlers.patch.mockReset();
  handlers.get.mockImplementation((url) => (url.startsWith('/api/clients') ? CLIENTS : {}));
  handlers.post.mockImplementation((url) => (url === GENERATE_URL ? BRIEF : {}));
});

describe('CreateBriefDialog', () => {
  it('says which kind of brief Meri will draft', async () => {
    renderDialog({ hasTranscript: false });
    expect(await screen.findByText(/this will be a preparation brief/)).toBeTruthy();
  });

  it('requires a client before drafting', async () => {
    renderDialog({ initialClientId: '' });
    await screen.findByRole('option', { name: 'Aperture Defense' });
    const generateButton = screen.getByRole('button', { name: 'Generate brief' }) as HTMLButtonElement;
    expect(generateButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: CLIENT_A } });
    expect(generateButton.disabled).toBe(false);
  });

  it('drafts with Meri and shows the sections for review before anything is saved', async () => {
    renderDialog();
    await screen.findByRole('option', { name: 'Aperture Defense' });
    // Archived clients are not offered.
    expect(screen.queryByRole('option', { name: 'Old Holdings' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Focus (optional)'), {
      target: { value: 'impact on the waiver ask' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));

    await screen.findByText('Executive summary');
    expect(screen.getByText('multiyear').tagName).toBe('STRONG');
    expect(screen.getByText('Funding stability matters').closest('li')).toBeTruthy();
    expect(screen.getByText('Recap brief · grounded in 1 source')).toBeTruthy();
    expect(calls.find((c) => c.url === GENERATE_URL)!.body).toEqual({
      clientId: CLIENT_A,
      focus: 'impact on the waiver ask',
    });
    expect(calls.some((c) => c.url.startsWith('/workspace-api/'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Save to Workspace' })).toBeTruthy();
  });

  it('applies a Meri edit to the draft and can undo it', async () => {
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === '/api/workspace/assistant') {
        return {
          reply: 'Tightened the summary.',
          edits: [
            { op: 'replace_section', section: 'executive summary', content: '<p>Shorter summary.</p>' },
            { op: 'replace_section', section: 'Missing section', content: '<p>x</p>' },
          ],
        };
      }
      return {};
    });
    renderDialog();
    await generate();

    const composer = screen.getByLabelText('Message Meri');
    fireEvent.change(composer, { target: { value: 'Tighten it' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await screen.findByText('Shorter summary.');
    expect(screen.queryByText('multiyear')).toBeNull();
    expect(screen.getByText('Tightened the summary.')).toBeTruthy();
    // A skipped edit is said, not swallowed.
    expect(screen.getByText(/Not applied: The target section no longer exists/)).toBeTruthy();

    // The REAL assistant contract: the live document + the hearing packet as context.
    const turn = calls.find((c) => c.url === '/api/workspace/assistant')!.body as {
      messages: unknown[];
      document: { title: string; client?: string; sections: Array<{ name: string; content: string }> };
      context: Array<{ label: string; text: string }>;
      clientId: string;
    };
    expect(turn.messages).toEqual([{ role: 'user', text: 'Tighten it' }]);
    expect(turn.document.title).toBe(BRIEF.title);
    expect(turn.document.client).toBe('Aperture Defense');
    expect(turn.document.sections[0]).toEqual({
      name: 'Executive summary',
      content: expect.stringContaining('<strong>multiyear</strong>'),
    });
    expect(turn.context[0]!.label).toBe('Hearing context packet');
    expect(turn.clientId).toBe(CLIENT_A);

    fireEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(screen.getByText('multiyear')).toBeTruthy();
    expect(screen.queryByText('Shorter summary.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo last edit' })).toBeNull();
  });

  it('reports a missing AI credential and creates no draft', async () => {
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) {
        throw { response: { status: 503, data: { message: 'AI provider unavailable' } } };
      }
      return {};
    });
    renderDialog();
    await screen.findByRole('option', { name: 'Aperture Defense' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No AI credential is configured for this tenant.',
    );
    expect(screen.queryByRole('button', { name: 'Save to Workspace' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/workspace-api/'))).toBe(false);
    // Retryable in place.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('saves through Workspace in three steps and reports the draft id', async () => {
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === '/workspace-api/drafts') return { id: 'draft-9' };
      return {};
    });
    const { onSaved } = renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Save to Workspace' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('draft-9'));
    expect(
      calls.filter((c) => c.url.startsWith('/workspace-api/')).map((c) => `${c.method} ${c.url}`),
    ).toEqual([
      'post /workspace-api/drafts',
      'patch /workspace-api/drafts/draft-9',
      'post /workspace-api/drafts/draft-9/context',
    ]);
    expect(calls.find((c) => c.url === '/workspace-api/drafts')!.body).toEqual({
      docTitle: BRIEF.title,
      client: 'Aperture Defense',
    });
  });

  it('downloads the reviewed brief as a Word document', async () => {
    const EXPORT_URL = `/api/legiwatch/live-hearings/events/${HEARING_ID}/actions/brief/export`;
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === EXPORT_URL) return new ArrayBuffer(8);
      return {};
    });
    renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Download .docx' }));

    await waitFor(() => expect(calls.some((c) => c.url === EXPORT_URL)).toBe(true));
    const exportCall = calls.find((c) => c.url === EXPORT_URL)!.body as {
      title: string;
      mode: string;
      sections: Array<{ name: string; content: string }>;
      clientName: string;
    };
    expect(exportCall.title).toBe(BRIEF.title);
    expect(exportCall.mode).toBe(BRIEF.mode);
    expect(exportCall.clientName).toBe('Aperture Defense');
    expect(exportCall.sections.map((s) => s.name)).toEqual(['Executive summary', 'Key exchanges']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves the reviewed brief to the client profile and reports success', async () => {
    const SAVE_URL = `/api/legiwatch/live-hearings/events/${HEARING_ID}/actions/brief/save-to-client`;
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === SAVE_URL) return { attachmentId: 'attach-1', fileName: 'hearing-brief.docx' };
      return {};
    });
    renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Save to client profile' }));

    await screen.findByText("Saved to Aperture Defense's Documents.");
    const saveCall = calls.find((c) => c.url === SAVE_URL)!.body as { clientId: string };
    expect(saveCall.clientId).toBe(CLIENT_A);
  });

  it('keeps the dialog open while a client-profile save is in flight, and closes normally once it settles', async () => {
    const SAVE_URL = `/api/legiwatch/live-hearings/events/${HEARING_ID}/actions/brief/save-to-client`;
    let resolveSave: (value: unknown) => void = () => {};
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === SAVE_URL) return new Promise((resolve) => { resolveSave = resolve; });
      return {};
    });
    const { onClose } = renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Save to client profile' }));
    await screen.findByText(/Saving to Aperture Defense.s Documents/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();

    resolveSave({ attachmentId: 'attach-1', fileName: 'hearing-brief.docx' });
    await screen.findByText("Saved to Aperture Defense's Documents.");

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports a client-save failure without saving to Workspace as a side effect', async () => {
    const SAVE_URL = `/api/legiwatch/live-hearings/events/${HEARING_ID}/actions/brief/save-to-client`;
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === SAVE_URL) throw { response: { data: { message: 'Attachment storage unavailable' } } };
      return {};
    });
    renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Save to client profile' }));

    expect(await screen.findByText('Attachment storage unavailable')).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/workspace-api/'))).toBe(false);
  });

  it('never reports success when saving fails', async () => {
    handlers.post.mockImplementation((url: string) => {
      if (url === GENERATE_URL) return BRIEF;
      if (url === '/workspace-api/drafts') {
        throw { response: { data: { message: 'Workspace is read-only' } } };
      }
      return {};
    });
    const { onSaved } = renderDialog();
    await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Save to Workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace is read-only');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save to Workspace' })).toBeTruthy();
  });
});
