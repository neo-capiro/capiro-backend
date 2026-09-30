import {
  projectResearchObserverEvent,
  projectResearchObserverError,
  ResearchTerminalError,
  RESEARCH_CANCELLED,
  RESEARCH_LEASE_FAILURE,
  RESEARCH_OBSERVER_STATUS,
  RESEARCH_PARTIAL,
  RESEARCH_PROVIDER_FAILURE,
  RESEARCH_RUN_FAILURE,
} from './research-observer-projection.js';

const PRIVATE = 'RAW_PRIVATE_OWNER_DETAIL_IN_TYPED_FRAME';

describe('research observer projection', () => {
  it.each([
    { type: 'text', text: PRIVATE, extra: PRIVATE },
    { type: 'artifact', artifact: { bodyText: PRIVATE }, extra: PRIVATE },
    { type: 'page_write', target: PRIVATE, body: PRIVATE, extra: PRIVATE },
    {
      type: 'grounding_caveat',
      topSeverity: PRIVATE,
      findings: [{ check: PRIVATE, severity: PRIVATE, detail: PRIVATE }],
      extra: PRIVATE,
    },
    { type: 'done', reply: PRIVATE, extra: PRIVATE },
    { type: 'error', message: PRIVATE, extra: PRIVATE },
    { type: 'unknown_private_frame', label: PRIVATE, extra: PRIVATE },
  ])('withholds content-bearing or unrecognized $type frames', (event) => {
    expect(projectResearchObserverEvent(event)).toBeNull();
  });

  it('projects start, runtime, reasoning, approval and tool completion to finite statuses', () => {
    const events = [
      { type: 'start', runtime: PRIVATE, label: PRIVATE, extra: PRIVATE },
      { type: 'runtime', runtime: 'meriv3', model: PRIVATE, telemetry: { reason: PRIVATE } },
      { type: 'reasoning', text: PRIVATE, extra: PRIVATE },
      {
        type: 'pending_approval',
        tool: 'send_email',
        label: PRIVATE,
        reason: PRIVATE,
        preview: { reason: PRIVATE, fields: { body: PRIVATE } },
      },
      { type: 'tool_done', tool: 'send_email', label: PRIVATE, status: 'blocked', detail: PRIVATE },
      { type: 'tool_done', tool: 'search_memory', label: PRIVATE, status: 'done', detail: PRIVATE },
      {
        type: 'tool_done',
        tool: 'search_memory',
        label: PRIVATE,
        status: 'error',
        detail: PRIVATE,
      },
    ].map((event) => projectResearchObserverEvent(event));

    expect(events).toEqual([
      { type: 'progress', note: 'Starting the research runtime…' },
      { type: 'progress', note: 'Starting the research runtime…' },
      { type: 'progress', note: 'Reviewing evidence and preparing the report…' },
      { type: 'progress', note: 'Research is continuing in read-only mode.' },
      { type: 'progress', note: 'Research is continuing in read-only mode.' },
      { type: 'progress', note: 'Research source step finished.' },
      { type: 'progress', note: 'Research source step needs attention.' },
    ]);
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    expect(RESEARCH_PROVIDER_FAILURE).not.toContain(PRIVATE);
  });

  it('uses only the canonical public source registry and never provider labels', () => {
    expect(
      projectResearchObserverEvent({
        type: 'tool_call',
        tool: 'search_memory',
        label: PRIVATE,
        providerCallId: PRIVATE,
        extra: PRIVATE,
      }),
    ).toEqual({ type: 'step', tool: 'search_memory', label: 'Research source' });
    expect(
      projectResearchObserverEvent({
        type: 'tool_call',
        tool: 'private_lowercase_owner',
        label: PRIVATE,
        extra: PRIVATE,
      }),
    ).toEqual({ type: 'progress', note: 'Reading an authorized research source…' });
  });

  it('replaces arbitrary progress notes and strips extra keys', () => {
    expect(
      projectResearchObserverEvent({
        type: 'progress',
        note: PRIVATE,
        label: PRIVATE,
        extra: PRIVATE,
      }),
    ).toEqual({ type: 'progress', note: 'Reviewing evidence and preparing the report…' });
  });

  it('keeps useful service-authored progress finite and source-independent', () => {
    for (const note of Object.values(RESEARCH_OBSERVER_STATUS)) {
      expect(projectResearchObserverEvent({ type: 'progress', note, extra: PRIVATE })).toEqual({
        type: 'progress',
        note,
      });
    }
  });

  it('maps provider, cancellation, partial, lease and unknown errors to fixed messages', () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const lease = new AbortController();
    const leaseReason = new Error(PRIVATE);
    leaseReason.name = 'ResearchLeaseError';
    lease.abort(leaseReason);
    expect(projectResearchObserverError(new ResearchTerminalError('provider', PRIVATE))).toBe(
      RESEARCH_PROVIDER_FAILURE,
    );
    expect(projectResearchObserverError(new ResearchTerminalError('partial', PRIVATE))).toBe(
      RESEARCH_PARTIAL,
    );
    expect(projectResearchObserverError(new Error(PRIVATE), cancelled.signal)).toBe(
      RESEARCH_CANCELLED,
    );
    expect(projectResearchObserverError(new Error(PRIVATE), lease.signal)).toBe(
      RESEARCH_LEASE_FAILURE,
    );
    expect(projectResearchObserverError(new Error(PRIVATE))).toBe(RESEARCH_RUN_FAILURE);
  });

  it.each(['cancelled', 'partial', 'lease', 'max_output_tokens', 'no longer owns the run'])(
    'does not infer terminal cause from arbitrary provider prose containing %s',
    (word) => {
      expect(projectResearchObserverError(new Error(`unrelated ${word} prose ${PRIVATE}`))).toBe(
        RESEARCH_RUN_FAILURE,
      );
    },
  );

  it('accepts a canonical receipt candidate only for the internal receipt barrier', () => {
    const result = projectResearchObserverEvent(
      {
        type: 'source',
        source: {
          tool: 'read_client_documents',
          label: PRIVATE,
          summary: PRIVATE,
          confidence: 'high',
          extra: PRIVATE,
        },
        durableSafeRead: {
          outcome: 'complete',
          executionId: 'execution-1',
          toolCallId: 'call-1',
          tool: 'read_client_documents',
          toolVersion: 'sha256:schema',
          input: { documentId: 'document-1' },
          result: { records: [{ id: 'record-1', body: PRIVATE }] },
          arbitraryExtra: PRIVATE,
        },
        arbitraryExtra: PRIVATE,
      },
      { receiptCandidates: true },
    );

    expect(result).toEqual({
      type: 'source',
      source: {
        tool: 'read_client_documents',
        label: 'Research source',
        summary: 'Authorized read completed',
        confidence: 'high',
      },
      durableSafeRead: {
        outcome: 'complete',
        tool: 'read_client_documents',
        toolCallId: 'call-1',
        executionId: 'execution-1',
        toolVersion: 'sha256:schema',
        input: { documentId: 'document-1' },
        result: { records: [{ id: 'record-1', body: PRIVATE }] },
      },
    });
    expect(JSON.stringify(result?.source)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain('arbitraryExtra');
    expect(
      projectResearchObserverEvent(
        {
          type: 'source',
          source: { tool: 'private_lowercase_owner', confidence: 'high' },
          durableSafeRead: {
            outcome: 'complete',
            tool: 'private_lowercase_owner',
            toolCallId: 'call-1',
            persisted: true,
          },
        },
        { receiptCandidates: true },
      ),
    ).toBeNull();
    expect(projectResearchObserverEvent(result)).toBeNull();
  });
});
