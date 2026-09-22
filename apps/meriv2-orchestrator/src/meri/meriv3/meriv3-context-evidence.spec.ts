import { ledgerToToolResultMap, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { extractCitationsFromToolResult, validateFormBCitations } from '@capiro/shared';
import {
  seedMeriContextEvidence,
  meriEvidenceManifest,
  compareMeriCitationNumbering,
  numberMeriEvidenceCitations,
  numberMeriEvidenceCitationsForMode,
} from './meriv3-context-evidence.js';
import {
  buildMeriV3ReleaseCitations,
  normalizeMeriV3FormBCitations,
} from './meriv3-clean-assistant.service.js';

function context(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'meri.chat',
    prompt: 'Governed prompt',
    retrieval: {} as MeriGovernedTurnContext['retrieval'],
    contextPacket: {
      packetId: 'packet-1',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    evidence: {
      version: 1,
      tenantId: 'tenant-1',
      userId: 'user-1',
      packetId: 'packet-1',
      sourceRecordCount: 8,
      projectedRecordCount: 6,
      truncated: true,
      records: Array.from({ length: 6 }, (_, index) => ({
        domain: 'meetings',
        recordId: `meeting-${index}`,
        payload: { title: `Meeting ${index}`, body: 'Only enacted funding may be used.' },
        provenance: { sourceUrl: `https://example.gov/meeting/${index}` },
        projection: { truncated: index === 5, originalCharacters: 100, returnedCharacters: 40 },
      })),
    },
  } as MeriGovernedTurnContext;
}

describe('initial evidence stays in the same citation and grounding ledger', () => {
  it('keeps a no-tool answer grounded and citable through final source rendering', () => {
    const seeded = seedMeriContextEvidence(context());
    expect(seeded.citations).toHaveLength(6);
    expect(seeded.citationPrompt).toContain('[6]');
    const answer = 'Use enacted funding [S:context_plane:meeting-5].';
    const checked = validateFormBCitations(answer, ledgerToToolResultMap(seeded.ledgerEntries));
    expect(checked).toMatchObject({ invalid: [] });
    const release = buildMeriV3ReleaseCitations(seeded.citations, seeded.ledgerEntries);
    expect(normalizeMeriV3FormBCitations(answer, release.aliases)).toBe('Use enacted funding [6].');
    expect(release.citations[5]).toMatchObject({
      id: 'meeting-5',
      url: 'https://example.gov/meeting/5',
    });
  });

  it('carries governed monday items into the actual answer citation ledger', () => {
    const governed = context();
    governed.evidence!.records = [
      {
        domain: 'monday',
        recordId: '18431248553:13088410202',
        payload: {
          clientId: 'client-1',
          sourceActorUserId: 'user-1',
          title: 'Mapped client deliverable',
          status: 'active',
          origin: { provider: 'monday', boardId: '18431248553', itemId: '13088410202' },
          url: 'https://example.monday.com/boards/18431248553/pulses/13088410202',
        },
        provenance: {
          source: 'managed_monday_mcp',
          boardId: '18431248553',
          itemId: '13088410202',
        },
        projection: { truncated: false, originalCharacters: 200, returnedCharacters: 200 },
      },
    ];
    governed.evidence!.sourceRecordCount = 1;
    governed.evidence!.projectedRecordCount = 1;
    governed.evidence!.truncated = false;

    const seeded = seedMeriContextEvidence(governed);
    expect(seeded.citations).toEqual([
      expect.objectContaining({
        id: '18431248553:13088410202',
        title: 'Mapped client deliverable',
        url: 'https://example.monday.com/boards/18431248553/pulses/13088410202',
        tool: 'context_plane',
      }),
    ]);
    expect(seeded.ledgerEntries[0]?.serialized).toContain('managed_monday_mcp');
    expect(
      validateFormBCitations(
        'The mapped deliverable is active [S:context_plane:18431248553:13088410202].',
        ledgerToToolResultMap(seeded.ledgerEntries),
      ).invalid,
    ).toEqual([]);
  });

  it('retains inherited document identity, exact excerpt, numbering and limitations through JSON reload', () => {
    const governed = context();
    const citation = {
      n: 56,
      type: 'source',
      tool: 'read_client_documents',
      id: 'doc-page-22',
      title: 'Capiro 2.0.pdf',
      snippet: 'Original snippet',
      url: null,
      documentEvidence: {
        clientId: 'client-1',
        documentId: 'doc-1',
        contentHash: 'a'.repeat(64),
        record: {
          recordId: 'doc-page-22',
          payload: {
            id: 'doc-page-22',
            title: 'Capiro 2.0.pdf',
            text: 'The exact page excerpt.',
            section: 22,
          },
        },
        coverage: { complete: false, truncated: true, disclosure: 'Visual page extraction only' },
        observedAt: '2026-09-07T00:00:00Z',
      },
    };
    governed.inheritedDocumentEvidence = JSON.parse(JSON.stringify([citation]));
    const seeded = seedMeriContextEvidence(governed);
    expect(seeded.citations[0]).toEqual(citation);
    expect(seeded.citations[1]?.n).toBe(1);
    expect(new Set(seeded.citations.map((source) => source.n)).size).toBe(seeded.citations.length);
    expect(seeded.citationPrompt).toContain('Visual page extraction only');
    expect(seeded.citationPrompt).toContain('The exact page excerpt.');
    const release = buildMeriV3ReleaseCitations(seeded.citations, seeded.ledgerEntries);
    expect(
      normalizeMeriV3FormBCitations(
        'Observation [S:read_client_documents:doc-page-22].',
        release.aliases,
      ),
    ).toBe('Observation [56].');
    expect(
      release.citations.find((source) => source.id === 'doc-page-22')?.documentEvidence,
    ).toEqual(citation.documentEvidence);
    expect(
      meriEvidenceManifest(governed, release.citations, seeded.ledgerEntries).sources.find(
        (source) => source.id === 'doc-page-22',
      ),
    ).toMatchObject({
      id: 'doc-page-22',
      origin: 'conversation',
      truncated: true,
    });
  });

  it('allocates around inherited [999] and reuses an existing document number when it is reread', () => {
    const source = {
      n: 999,
      type: 'source',
      id: 'doc-page-22',
      title: 'PDF',
      url: null,
      snippet: 'Page observation',
      tool: 'read_client_documents',
    };
    const current = { ...source, id: 'meeting-1', tool: 'context_plane', n: 1 };
    const { citations: numbered } = numberMeriEvidenceCitations(
      [{ ...source, n: 1 }, current],
      [source],
    );
    expect(numbered.map(({ id, n }) => ({ id, n }))).toEqual([
      { id: 'doc-page-22', n: 999 },
      { id: 'meeting-1', n: 1 },
    ]);
    expect(numberMeriEvidenceCitations([current], numbered).citations[0]?.n).toBe(1);
  });

  it('uses stable fallback identities for id-less evidence without collapsing distinct rows', () => {
    const base = {
      n: 1,
      type: 'web',
      id: '',
      title: 'First result',
      url: 'https://example.gov/first',
      snippet: 'First snippet',
      tool: 'search_public_web',
    };
    const second = { ...base, title: 'Second result', url: 'https://example.gov/second' };
    const result = numberMeriEvidenceCitations([base, second, base], [], {
      stableIdentity: true,
    });

    expect(result.citations.map(({ n, stableId }) => ({ n, stableId }))).toEqual([
      { n: 1, stableId: expect.stringMatching(/^[a-f0-9]{16}$/) },
      { n: 2, stableId: expect.stringMatching(/^[a-f0-9]{16}$/) },
      { n: 1, stableId: expect.stringMatching(/^[a-f0-9]{16}$/) },
    ]);
    expect(result.citations[0]?.stableId).not.toBe(result.citations[1]?.stableId);
    expect(result.citations[0]?.stableId).toBe(result.citations[2]?.stableId);
  });

  it('keeps shadow numbering equal to legacy while measuring enforce collisions', () => {
    const base = {
      n: 1,
      type: 'web',
      id: '',
      title: 'First result',
      url: 'https://example.gov/first',
      snippet: 'First snippet',
      tool: 'search_public_web',
    };
    const rows = [base, { ...base, title: 'Second result', url: 'https://example.gov/second' }];

    const comparison = compareMeriCitationNumbering(rows, []);

    expect(comparison.legacy).toEqual(numberMeriEvidenceCitations(rows, []));
    expect(comparison.legacy.citations.map(({ n }) => n)).toEqual([1, 1]);
    expect(comparison.stable.citations.map(({ n }) => n)).toEqual([1, 2]);
    expect(comparison.collisions).toBe(1);
    expect(comparison.overflow).toBe(0);
  });

  it('returns off-identical shadow output, enforce differences, and reports shadow counts once', () => {
    const base = {
      n: 1,
      type: 'web',
      id: '',
      title: 'First result',
      url: 'https://example.gov/first',
      snippet: 'First snippet',
      tool: 'search_public_web',
    };
    const rows = [base, { ...base, title: 'Second result', url: 'https://example.gov/second' }];
    const observe = jest.fn();

    const off = numberMeriEvidenceCitationsForMode(rows, [], 'off');
    const shadow = numberMeriEvidenceCitationsForMode(rows, [], 'shadow', observe);
    const enforce = numberMeriEvidenceCitationsForMode(rows, [], 'enforce');

    expect(shadow).toEqual(off);
    expect(enforce).not.toEqual(off);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ collisions: 1, overflow: 0 });
  });

  it('records sources beyond marker 999 as overflow', () => {
    const existing = Array.from({ length: 999 }, (_, index) => ({
      n: index + 1,
      type: 'source',
      id: `source-${index + 1}`,
      title: `Source ${index + 1}`,
      url: null,
      snippet: null,
      tool: 'search_memory',
    }));
    const candidate = { ...existing[0]!, id: 'source-1000', title: 'Overflow source' };
    const result = numberMeriEvidenceCitations([candidate], existing, { stableIdentity: true });

    expect(result.citations).toEqual([]);
    expect(result.overflow).toEqual([candidate]);
  });

  it('numbers subsequent tool evidence after initial sources and saves a body-free manifest', () => {
    const governed = context();
    const seed = seedMeriContextEvidence(governed);
    const toolCitations = extractCitationsFromToolResult(
      'search_memory',
      { data: [{ id: 'memory-1', title: 'Client preference', body: 'Private fact body' }] },
      seed.citations.length + 1,
    );
    expect(toolCitations[0]?.n).toBe(7);
    const manifest = meriEvidenceManifest(governed, [...seed.citations, ...toolCitations]);
    expect(manifest).toMatchObject({
      packetId: 'packet-1',
      sourceRecordCount: 8,
      projectedRecordCount: 6,
      truncated: true,
    });
    expect(manifest.sources[5]).toMatchObject({
      id: 'meeting-5',
      origin: 'initial_context',
      truncated: true,
    });
    expect(manifest.sources[6]).toMatchObject({ id: 'memory-1', origin: 'tool', truncated: null });
    expect(JSON.stringify(manifest)).not.toContain('Private fact body');
    expect(JSON.stringify(manifest)).not.toContain('Only enacted funding');
  });
});
