import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { meriRuntimeStatus } from '../../components/chat/meri-runtime-status.js';
import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { artifactDownloadResponse, artifactFixture } from '../../test/meri-artifact-download-fixtures.js';

vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('./meri-icons.js', () => ({
  MeriIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));
vi.mock('./MeriAnalysisChartCard.js', () => ({ MeriAnalysisChartCard: () => null }));
vi.mock('./MeriMessageFeedback.js', () => ({ MeriMessageFeedback: () => null }));
vi.mock('./MeriMemoryCallout.js', () => ({ MeriMemoryCallout: () => null }));
vi.mock('./MeriAttachmentChip.js', () => ({
  MeriAttachmentChip: () => null,
  attachmentChipSpec: vi.fn(),
}));
vi.mock('./MeriWorkPerformed.js', () => ({
  MeriWorkPerformed: ({ planSteps }: { planSteps: string[] }) => (
    <div aria-label="Planned work">{planSteps.join(' ')}</div>
  ),
}));
vi.mock('./MeriResearchProgress.js', () => ({
  MeriResearchProgress: ({ steps }: { steps: TrustStep[] }) => (
    <div aria-label="Research progress">{steps.map((step) => step.label).join(' ')}</div>
  ),
}));

import { VNextMeriMessage } from './VNextMeriMessage.js';
import { mapPersistedDocuments } from './meri-route-state.js';
import { MeriArtifactCanvas } from './MeriArtifactCanvas.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const savedStep: TrustStep = {
  tool: 'get_client_context',
  label: 'Reviewed client profile',
  status: 'done',
  detail: 'Read 3 capabilities',
  count: 3,
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'saved-turn',
    role: 'assistant',
    content: 'The answer based on the client profile.',
    createdAt: new Date('2026-09-06T00:00:00Z'),
    planSteps: ['Review the selected client.'],
    trustSteps: [savedStep],
    orchestratorIntent: 'query_clients',
    orchestratorTier: 'deep',
    ...overrides,
  };
}

function controller(overrides: Record<string, unknown> = {}): MeriChatController {
  return {
    researchReports: {},
    researchOffers: {},
    pendingApprovals: [],
    isResearchStreaming: false,
    planSteps: ['Search current legislation.'],
    trustSteps: [{ tool: 'search_bills', label: 'Searching new bills', status: 'running' }],
    orchestratorIntent: 'query_intelligence',
    orchestratorTier: 'fast',
    ...overrides,
  } as unknown as MeriChatController;
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    message: message(),
    controller: controller(),
    isLastAssistant: true,
    isStreaming: false,
    onOpenMemory: vi.fn(),
    onOpenSourceDetail: vi.fn(),
    onOpenTurnInspector: vi.fn(),
    ...overrides,
  };
}

describe('Meri message work performed', () => {
  test('strips unresolved markers only for enforce messages', () => {
    const { rerender } = render(<VNextMeriMessage {...props({ message: message({ content: 'Verified [6] and missing [53].', citations: [{ n: 6, type: 'file', id: '6', title: 'Page 6', url: null, snippet: null, tool: 'open_file' }], evidenceAccuracy: 'enforce' }) })} />);
    expect(screen.getByRole('button', { name: '[6]' })).toBeTruthy();
    expect(screen.queryByText(/\[53\]/)).toBeNull();
    rerender(<VNextMeriMessage {...props({ message: message({ content: 'Legacy [53].' }) })} />);
    expect(screen.getByText('Legacy [53].')).toBeTruthy();
  });

  test.each([
    ['', 'Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['?format=pdf', 'PDF', 'application/pdf', 'pdf'],
    ['?format=docx', 'Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ] as const)('replays and downloads the observed historical sandbox artifact link %s through Markdown sanitation', async (query, label, mime, extension) => {
    const artifactId = '829ed073-157b-4d51-856c-8fbc64ec98ab';
    const route = `/api/clio/artifacts/${artifactId}/download`;
    const content = `[Download the ${label} briefing](sandbox:${route}${query})`;
    const fixture = artifactFixture(mime);
    const fetchMock = vi.fn().mockImplementation(async () => artifactDownloadResponse({
      mime, artifactId, disposition: `attachment; filename="briefing.${extension}"`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-briefing');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    const authHeaders = vi.fn(async () => ({ Authorization: 'Bearer current-user' }));
    const original = props({ message: message({ content }), controller: controller({ authHeaders }) });
    const view = render(<VNextMeriMessage {...original} />);
    expect(screen.queryByRole('link', { name: `Download the ${label} briefing` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Download the ${label} briefing` }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    view.unmount();
    render(<VNextMeriMessage {...original} message={{ ...original.message, content: JSON.parse(JSON.stringify(content)) }} />);
    fireEvent.click(screen.getByRole('button', { name: `Download the ${label} briefing` }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    for (const [downloaded] of create.mock.calls) {
      const downloadedBlob = downloaded as Blob;
      const downloadedBuffer = await downloadedBlob.arrayBuffer();
      const downloadedBytes = new Uint8Array(downloadedBuffer);
      const digest = await crypto.subtle.digest('SHA-256', downloadedBuffer);
      expect(downloadedBlob.type).toBe(mime);
      expect(downloadedBytes).toEqual(fixture.bytes);
      expect(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(fixture.sha256);
    }
    expect(filename).toBe(`briefing.${extension}`);
    expect(authHeaders).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toMatch(new RegExp(`${route.replaceAll('/', '\\/')}${query ? '\\?format=' + extension : ''}$`));
      expect(url).not.toContain('sandbox:');
      expect(options).toMatchObject({ headers: { Authorization: 'Bearer current-user' }, redirect: 'error', cache: 'no-store' });
    }
  });

  test.each([
    'sandbox://evil.example.test/api/clio/artifacts/saved-briefing/download',
    'sandbox:/api/clio/artifacts/saved-briefing/download/../../private',
    'sandbox:/mnt/data/private.pdf',
    'sandbox:/api/clio/artifacts/saved-briefing/download?format=pdf&token=secret',
    'javascript:alert(1)',
  ])('keeps Markdown sanitation and auth isolation for unrecognized links: %s', (href) => {
    const authHeaders = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<VNextMeriMessage {...props({ message: message({ content: `[Unrecognized file](${href})` }), controller: controller({ authHeaders }) })} />);
    expect(screen.queryByRole('button', { name: 'Unrecognized file' })).toBeNull();
    expect(container.querySelector('a[href^="sandbox:"], a[href^="javascript:"]')).toBeNull();
    expect(authHeaders).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reopens the persisted PDF document from a historical message with both export controls', () => {
    const saved = { id: 'saved-pdf', title: 'Glass Harbor QA', kind: 'pdf_document', bodyText: JSON.stringify({
      title: 'Glass Harbor QA', sections: [{ heading: 'Evidence', paragraphs: ['Checksum BLUE-ORBIT-47; no approval claimed.'] }],
    }) };
    const documentArtifacts = mapPersistedDocuments(JSON.parse(JSON.stringify({ artifacts: [saved] })));
    const setActiveArtifact = vi.fn();
    render(<VNextMeriMessage {...props({ message: message({ documentArtifacts }), controller: controller({ setActiveArtifact }) })} />);
    const exports = within(screen.getByRole('group', { name: 'Glass Harbor QA exports' }));
    expect(exports.getByRole('button', { name: 'Download Word' })).toBeEnabled();
    expect(exports.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Glass Harbor QA' }));
    expect(setActiveArtifact).toHaveBeenCalledWith(saved);
    render(<MeriArtifactCanvas artifact={setActiveArtifact.mock.calls[0]![0]} onClose={vi.fn()} />);
    expect(screen.getByRole('article', { name: 'PDF document preview' })).toHaveTextContent('BLUE-ORBIT-47');
    expect(screen.getByRole('button', { name: 'Download .pdf' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download .docx' })).toBeEnabled();
  });

  test('keeps stopped-before-text work inspectable without offering copy or feedback for an empty response', () => {
    const original = props({ message: message({ content: '', planSteps: [], trustSteps: [], orchestratorIntent: null,
      runtimeStatus: meriRuntimeStatus({ finishReason: 'aborted', partial: true }),
    }) });
    render(<VNextMeriMessage {...original} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopped.');
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(expect.objectContaining({
      thinking: expect.objectContaining({ runtimeStatus: expect.objectContaining({ lifecycle: 'stopped' }) }),
    }), 'thinking');
    expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument();
  });

  test.each([
    ['stop', false, 'completed', 'Completed.'],
    ['aborted', true, 'stopped', 'Stopped. This response is partial.'],
    ['error', true, 'failed', 'Failed. This response is incomplete.'],
  ])('uses saved %s lifecycle in the transcript and inspector without tools', (finishReason, partial, lifecycle, text) => {
    const original = props({ message: message({
      planSteps: [], trustSteps: [], orchestratorIntent: null,
      runtimeStatus: meriRuntimeStatus({ finishReason, partial }),
    }) });
    render(<VNextMeriMessage {...original} />);
    expect(screen.getByRole('status')).toHaveTextContent(String(text));
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: expect.objectContaining({ runtimeStatus: expect.objectContaining({ lifecycle }) }) }),
      'thinking',
    );
  });

  test('hands the source panel and inspector the same reloaded historical scope after picker changes', () => {
    const turnScope = { kind: 'client' as const, clientId: 'l3', clientName: 'L3 Harris', targetHint: null };
    const original = props({ message: message({
      turnScope: JSON.parse(JSON.stringify(turnScope)), contextPacketId: 'original-packet',
      content: 'Evidence [7].', citations: [{ n: 7, id: 'doc', title: 'Original evidence',
        type: 'source', tool: 'read_client_documents', url: null, snippet: 'Original excerpt' }],
    }) });
    const { rerender } = render(<VNextMeriMessage {...original} />);
    for (const selectedClientValue of ['l3', 'anduril', '', 'l3']) {
      rerender(<VNextMeriMessage {...original} controller={controller({ selectedClientValue })} />);
      fireEvent.click(screen.getByRole('button', { name: '[7]' }));
      fireEvent.click(screen.getByRole('button', { name: /view full source/i }));
      expect(original.onOpenSourceDetail).toHaveBeenLastCalledWith(original.message.citations, 0, turnScope);
      fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
      expect(original.onOpenTurnInspector).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnScope, contextPacketId: 'original-packet' }), 'thinking',
      );
    }
  });

  test('renders generated-file Markdown links as authenticated download controls while retaining source links', () => {
    render(<VNextMeriMessage {...props({ message: message({
      content: '[Download Word](/api/clio/artifacts/saved-briefing/download) and [External source](https://congress.gov).',
    }), controller: controller({ authHeaders: async () => ({ Authorization: 'Bearer current-user' }) }) })} />);
    expect(screen.getByRole('button', { name: 'Download Word' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Download Word' })).toBeNull();
    expect(screen.getByRole('link', { name: 'External source' })).toHaveAttribute('href', 'https://congress.gov');
  });

  test('shows ordinary pending progress as status without attributing a tool or research run', () => {
    const { rerender } = render(
      <VNextMeriMessage
        {...props({
          message: message({ content: '', trustSteps: [], planSteps: [] }),
          controller: controller({
            trustSteps: [],
            planSteps: [],
            orchestratorIntent: null,
            turnProgress: {
              note: 'Reading authorized client context',
              elapsedMs: 18000,
            },
          }),
          isStreaming: true,
        })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Reading authorized client context · 18s elapsed',
    );
    expect(screen.queryByLabelText('Research progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviewed client profile')).not.toBeInTheDocument();
    rerender(
      <VNextMeriMessage
        {...props({
          controller: controller({
            turnProgress: { note: 'Reading authorized client context', elapsedMs: 18000 },
          }),
          isStreaming: false,
        })}
      />,
    );
    expect(screen.queryByText(/Reading authorized client context/)).not.toBeInTheDocument();
  });

  test('uses the same source number and record in inline citations and the inspector', () => {
    const citation = {
      n: 7,
      id: 'attachment-1',
      title: 'Earlier attachment',
      type: 'source',
      tool: 'get_research_evidence',
      url: null,
      snippet: 'Verified attachment evidence.',
    };
    const original = props({
      message: message({ content: 'Evidence [7].', citations: [citation] }),
    });
    render(<VNextMeriMessage {...original} />);
    fireEvent.click(screen.getByRole('button', { name: '[7]' }));
    expect(screen.getByText('Verified attachment evidence.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          sources: [
            expect.objectContaining({
              citationNumber: 7,
              title: 'Earlier attachment',
            }),
          ],
        }),
      }),
      'thinking',
    );
  });

  test('keeps a completed turn’s work when a later turn starts streaming', () => {
    const original = props();
    const { rerender } = render(<VNextMeriMessage {...original} />);
    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);

    rerender(<VNextMeriMessage {...original} isLastAssistant={false} isStreaming />);

    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);
    expect(screen.queryByText('Searching new bills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icon-Loading01')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SHOW REASONING' }));
    expect(screen.getByText('Review the selected client.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'saved-turn',
        thinking: {
          plan: 'Review the selected client.',
          steps: [savedStep],
          intent: 'query_clients',
          tier: 'deep',
        },
      }),
      'thinking',
    );
  });

  test('renders the latest reloaded message and its inspector from saved work', () => {
    const original = props({
      controller: controller({
        planSteps: [],
        trustSteps: [],
        orchestratorIntent: null,
        orchestratorTier: null,
      }),
    });
    render(<VNextMeriMessage {...original} />);

    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: expect.objectContaining({
          steps: [savedStep],
          intent: 'query_clients',
          tier: 'deep',
        }),
      }),
      'thinking',
    );
  });

  test('does not borrow another turn’s work for a finished message without saved work', () => {
    render(
      <VNextMeriMessage
        {...props({
          message: message({
            planSteps: undefined,
            trustSteps: undefined,
            orchestratorIntent: undefined,
            orchestratorTier: undefined,
          }),
        })}
      />,
    );

    expect(screen.queryByLabelText('Work performed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show work' })).not.toBeInTheDocument();
    expect(screen.queryByText('Searching new bills')).not.toBeInTheDocument();
  });

  test('uses live work only on the streaming message and distinguishes tool statuses', () => {
    render(
      <VNextMeriMessage
        {...props({
          isStreaming: true,
          controller: controller({
            trustSteps: [
              { tool: 'search_bills', label: 'Searching new bills', status: 'running' },
              {
                tool: 'read_document',
                label: 'Document unavailable',
                status: 'error',
                detail: 'Access denied',
              },
              { tool: 'get_directory', label: 'Read directory', status: 'done' },
            ],
          }),
        })}
      />,
    );

    const work = within(screen.getByLabelText('Work performed'));
    expect(work.getByText('Searching new bills')).toHaveAttribute('title', 'Running');
    expect(work.getByTestId('icon-Loading01')).toBeInTheDocument();
    expect(work.getByTestId('icon-AlertCircle')).toBeInTheDocument();
    expect(work.getByTestId('icon-CheckCircle')).toBeInTheDocument();
    expect(work.getByText('Document unavailable')).toHaveAttribute(
      'title',
      'Not completed: Access denied',
    );
    expect(work.queryByText(savedStep.label)).not.toBeInTheDocument();
  });

  test('shows an unfinished saved step as incomplete after streaming ends', () => {
    render(
      <VNextMeriMessage
        {...props({
          message: message({
            trustSteps: [{ tool: 'search_bills', label: 'Interrupted search', status: 'running' }],
          }),
        })}
      />,
    );
    const work = within(screen.getByLabelText('Work performed'));

    expect(work.getByTestId('icon-Clock')).toBeInTheDocument();
    expect(work.queryByTestId('icon-Loading01')).not.toBeInTheDocument();
    expect(work.queryByTestId('icon-CheckCircle')).not.toBeInTheDocument();
    expect(work.getByText('Interrupted search')).toHaveAttribute('title', 'Incomplete');
  });

  test('keeps a saved plan visible when an earlier turn has no tool steps', () => {
    render(
      <VNextMeriMessage
        {...props({
          isLastAssistant: false,
          isStreaming: true,
          message: message({ trustSteps: [] }),
        })}
      />,
    );
    expect(screen.getByLabelText('Planned work')).toHaveTextContent('Review the selected client.');
    expect(screen.queryByText('Search current legislation.')).not.toBeInTheDocument();
  });

  test('retains the dedicated live research progress display', () => {
    render(
      <VNextMeriMessage
        {...props({ isStreaming: true, controller: controller({ isResearchStreaming: true }) })}
      />,
    );
    expect(screen.getByLabelText('Research progress')).toHaveTextContent('Searching new bills');
    expect(screen.queryByLabelText('Work performed')).not.toBeInTheDocument();
  });
});
