import { resolveMeriDocumentRequest, stripAppendedAttachmentText } from '@capiro/shared';
import {
  completeDocumentPages,
  documentPageReceipt,
  MeriDocumentCompletion,
} from './meriv3-document-completion.js';
import { observeMeriTurnToolCoverage, reconcileMeriTurnCoverage } from './meriv3-turn-coverage.js';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';

const request =
  'I uploaded our meeting transcripts. Make a list of the meetings and find exact names, positions and contact information.';
function page(
  start = 0,
  end = 5000,
  text = 'x'.repeat(10_000),
  extra: Record<string, unknown> = {},
) {
  return {
    tool: 'read_client_documents',
    clientId: 'client-1',
    document: { id: 'doc-1', fileName: 'Meeting transcript.txt', contentHash: 'a'.repeat(64) },
    coverage: {
      section: 1,
      sectionCount: 1,
      sectionCharacters: text.length,
      characterStart: start,
      characterEnd: end,
      nextCursor: end < text.length ? `next:${end}` : null,
      truncated: end < text.length,
      complete: start === 0 && end === text.length,
      query: null,
      ...extra,
    },
    records: [
      {
        recordId: `doc-1:${start}-${end}`,
        payload: {
          id: `doc-1:${start}-${end}`,
          documentId: 'doc-1',
          title: 'Meeting transcript.txt',
          text: text.slice(start, end),
          characterStart: start,
          characterEnd: end,
        },
      },
    ],
  };
}

describe('document task continuity and evidence coverage', () => {
  test('preserves the meeting/contact request through a file-location clarification', () => {
    const resolved = resolveMeriDocumentRequest([
      { role: 'user', text: 'What should I know about Acme?' },
      { role: 'assistant', text: 'Client overview.' },
      { role: 'user', text: request },
      { role: 'assistant', text: 'Where is the file?' },
      { role: 'user', text: 'I uploaded the transcript into the Acme files.' },
    ]);
    expect(resolved).toMatchObject({ completeRead: true, contacts: true });
    expect(resolved?.request).toContain(request);
    expect(resolved?.request).toContain('Acme files');
  });

  test('does not resurrect a document request across an unrelated task or cancellation', () => {
    expect(
      resolveMeriDocumentRequest([
        { role: 'user', text: request },
        { role: 'user', text: 'Draft an email to my team.' },
        { role: 'user', text: 'I uploaded the transcript into Acme files.' },
      ]),
    ).toBeNull();
    expect(
      resolveMeriDocumentRequest([
        { role: 'user', text: request },
        { role: 'user', text: 'Forget that. Tell me about this client.' },
      ]),
    ).toBeNull();
  });

  test('a narrow document question does not require complete extraction', () => {
    expect(
      resolveMeriDocumentRequest([
        { role: 'user', text: 'What does the uploaded transcript say about Alex?' },
      ]),
    ).toMatchObject({ completeRead: false, contacts: false });
  });

  test('a named slide or page is a targeted read; a whole-file summary is not', () => {
    const deck =
      '\n\nAttached document "qa-strategy-deck.pptx":\nSlide 1: List every program. Review all items.';
    const targeted = resolveMeriDocumentRequest([
      { role: 'user', text: `Summarize slide 6 of the strategy deck I uploaded.${deck}` },
    ]);
    expect(targeted).toMatchObject({
      request: 'Summarize slide 6 of the strategy deck I uploaded.',
      completeRead: false,
    });
    expect(
      resolveMeriDocumentRequest([
        { role: 'user', text: `Summarize the strategy deck I uploaded.${deck}` },
      ]),
    ).toMatchObject({ completeRead: true });
    expect(
      resolveMeriDocumentRequest([
        { role: 'user', text: 'List every action item on page 3 of the uploaded transcript.' },
      ]),
    ).toMatchObject({ completeRead: true });
  });

  test('words inside an attached file do not change what the user asked', () => {
    const resolved = resolveMeriDocumentRequest([
      {
        role: 'user',
        text: 'What does the uploaded transcript say about Alex?\n\nAttached document "notes.pdf":\nAll meetings. Full contact details for everyone.',
      },
    ]);
    expect(resolved).toMatchObject({
      request: 'What does the uploaded transcript say about Alex?',
      completeRead: false,
      contacts: false,
    });
    expect(stripAppendedAttachmentText('Plain question.')).toBe('Plain question.');
  });

  test('does not accept an isolated last page, gaps, another version, or hidden/truncated evidence', () => {
    const first = documentPageReceipt(page())!;
    const last = documentPageReceipt(page(5000, 10000))!;
    expect(completeDocumentPages([last])).toBe(false);
    expect(completeDocumentPages([first, { ...last, start: 6000 }])).toBe(false);
    expect(completeDocumentPages([first, { ...last, contentHash: 'b'.repeat(64) }])).toBe(false);
    expect(completeDocumentPages([first, { ...last, readable: false }])).toBe(false);
    expect(completeDocumentPages([first, last])).toBe(true);
    const omitted = { ...page(), records: [], projection: { truncated: true } };
    expect(documentPageReceipt(omitted)?.readable).toBe(false);
  });

  test('follows only same-client receipts and stops repeated cursors', () => {
    const gate = new MeriDocumentCompletion(
      resolveMeriDocumentRequest([{ role: 'user', text: request }])!,
      'client-1',
    );
    gate.observe(
      'read_client_documents',
      { clientId: 'client-1' },
      {
        documents: [{ id: 'doc-1' }],
        coverage: { nextCursor: null },
      },
    );
    gate.observe('read_client_documents', { clientId: 'other', documentId: 'doc-1' }, page());
    expect(gate.nextRead()).toBeNull();
    gate.observe('read_client_documents', { clientId: 'client-1', documentId: 'doc-1' }, page());
    const next = gate.nextRead()!;
    expect(next.cursor).toBe('next:5000');
    gate.observe('read_client_documents', next, page());
    expect(gate.nextRead()).toBeNull();
    expect(gate.gaps().join(' ')).toContain('not been fully reviewed');
  });

  test('restarts a search snippet at the beginning for exhaustive extraction', () => {
    const gate = new MeriDocumentCompletion(
      { request, completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe(
      'read_client_documents',
      { clientId: 'client-1' },
      { documents: [{ id: 'doc-1' }], coverage: {} },
    );
    gate.observe(
      'read_client_documents',
      { documentId: 'doc-1', query: 'Alex' },
      page(5000, 10000, undefined, { query: 'Alex' }),
    );
    expect(gate.nextRead()).toEqual({ clientId: 'client-1', documentId: 'doc-1' });
    expect(gate.gaps()).not.toHaveLength(0);
  });

  test('a repeated cursor does not strand another selected document', () => {
    const gate = new MeriDocumentCompletion(
      { request, completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe(
      'read_client_documents',
      { clientId: 'client-1' },
      { documents: [{ id: 'doc-1' }, { id: 'doc-2' }], coverage: {} },
    );
    gate.observe('read_client_documents', { clientId: 'client-1', documentId: 'doc-1' }, page());
    gate.observe('read_client_documents', gate.nextRead()!, page());
    const second = page();
    second.document.id = 'doc-2';
    gate.observe('read_client_documents', { clientId: 'client-1', documentId: 'doc-2' }, second);
    expect(gate.nextRead()).toEqual({
      clientId: 'client-1',
      documentId: 'doc-2',
      cursor: 'next:5000',
    });
  });

  test('reports failed/empty reads without releasing invented transcript content', () => {
    const gate = new MeriDocumentCompletion(
      { request, completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe('read_client_documents', { clientId: 'client-1' }, { error: 'Access denied' });
    expect(
      gate.partialReply('The upload failed. The transcript says invented details.'),
    ).not.toContain('invented details');
    expect(gate.partialReply('The upload failed.')).toContain(
      'does not establish that an upload failed',
    );
  });

  test('searches later sections when the first section has no literal match', () => {
    const gate = new MeriDocumentCompletion(
      { request: 'What does the transcript say about Alex?', completeRead: false, contacts: false },
      'client-1',
    );
    gate.observe(
      'read_client_documents',
      { clientId: 'client-1' },
      { documents: [{ id: 'doc-1' }], coverage: {} },
    );
    gate.observe(
      'read_client_documents',
      { documentId: 'doc-1', query: 'Alex' },
      {
        ...page(10000, 10000, undefined, {
          query: 'Alex',
          matched: false,
          sectionCount: 2,
          nextCursor: 'section:2',
        }),
        records: [],
      },
    );
    expect(gate.nextRead()).toEqual({
      clientId: 'client-1',
      documentId: 'doc-1',
      query: 'Alex',
      cursor: 'section:2',
    });
  });

  test('does not infer a complete listing from a projected subset', () => {
    const gate = new MeriDocumentCompletion(
      { request, completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe(
      'read_client_documents',
      { clientId: 'client-1' },
      {
        documents: [{ id: 'doc-1' }],
        coverage: { complete: true },
        projection: { truncated: true },
      },
    );
    expect(gate.gaps().join(' ')).toContain('file list was omitted');
  });

  test('coalesces complete document reads without hiding an initial retrieval gap', () => {
    const initial = {
      plan: { requiredDomains: ['contacts'] },
      coverage: {
        complete: true,
        requestedDomains: ['contacts'],
        missingDomains: [],
        partialDomains: [],
        unavailableSources: [],
        sourceHealth: [],
        searchedDomains: ['contacts'],
        toolsInvoked: [],
        paginationComplete: true,
      },
    } as unknown as MeriGovernedTurnContext['retrieval'];
    const reads = [
      ...observeMeriTurnToolCoverage('read_client_documents', page()),
      ...observeMeriTurnToolCoverage('read_client_documents', page(5000, 10000)),
    ];
    expect(reconcileMeriTurnCoverage(initial, reads).coverage.complete).toBe(true);
    expect(reconcileMeriTurnCoverage(initial, reads).coverage.searchedDomains).toEqual(
      expect.arrayContaining(['client_documents']),
    );
    expect(reconcileMeriTurnCoverage(initial, reads.slice(1)).coverage.complete).toBe(false);
    expect(
      reconcileMeriTurnCoverage(
        {
          ...initial,
          coverage: { ...initial.coverage, complete: false, partialDomains: ['contacts'] },
        },
        reads,
      ).coverage.complete,
    ).toBe(false);
  });
});

describe('chat attachment reads count toward document coverage', () => {
  const attachmentRead = (section: number, sectionCount: number, text: string) => ({
    tool: 'read_chat_attachments',
    clientId: 'client-1',
    source: {
      attachmentId: 'att-1',
      filename: 'annual-report.pdf',
      originalBytesHash: 'h'.repeat(64),
    },
    coverage: {
      mode: 'section',
      locator: { section, offset: 0 },
      sectionCount,
      characterStart: 0,
      characterEnd: text.length,
      sectionCharacters: text.length,
      extractionStatus: 'complete',
      query: null,
      nextCursor: section < sectionCount ? 'next' : null,
    },
    records: [{ payload: { characterStart: 0, characterEnd: text.length, text } }],
  });
  const listing = { documents: [{ id: 'doc-1' }], coverage: {} };

  test('a fully read attachment leaves no gap and is never reported as unread', () => {
    const gate = new MeriDocumentCompletion(
      { request: 'List every recommendation in the report.', completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe('read_client_documents', { clientId: 'client-1' }, listing);
    gate.observe(
      'read_chat_attachments',
      { attachmentId: 'att-1', section: 1 },
      attachmentRead(1, 2, 'Recommendation 1.'),
    );
    gate.observe(
      'read_chat_attachments',
      { attachmentId: 'att-1', section: 2 },
      attachmentRead(2, 2, 'Recommendation 2.'),
    );
    expect(gate.gaps()).toEqual([]);
  });

  test('a partly read attachment is reported as not fully reviewed, with its real text kept', () => {
    const gate = new MeriDocumentCompletion(
      { request: 'List every recommendation in the report.', completeRead: true, contacts: false },
      'client-1',
    );
    gate.observe('read_client_documents', { clientId: 'client-1' }, listing);
    gate.observe(
      'read_chat_attachments',
      { attachmentId: 'att-1', section: 1 },
      attachmentRead(1, 80, 'Recommendation 1.'),
    );
    const gaps = gate.gaps().join(' ');
    expect(gaps).toContain('annual-report.pdf has not been fully reviewed');
    expect(gaps).not.toContain('have not been read');
    expect(gate.partialReply('Found recommendation 1 on page 1.')).toContain(
      'Found recommendation 1 on page 1.',
    );
  });
});
