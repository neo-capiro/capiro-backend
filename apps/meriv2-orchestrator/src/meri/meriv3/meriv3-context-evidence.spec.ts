import { ledgerToToolResultMap, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { extractCitationsFromToolResult, validateFormBCitations } from '@capiro/shared';
import { seedMeriContextEvidence, meriEvidenceManifest } from './meriv3-context-evidence.js';
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
