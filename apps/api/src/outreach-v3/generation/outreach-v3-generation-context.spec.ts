import type { OutreachResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import { MAX_EVIDENCE_ITEM_CHARS } from '../../engagement/generation/evidence-packet.types.js';
import {
  OutreachV3GenerationContextError,
  prepareOutreachV3ContextForGeneration,
} from './outreach-v3-generation-context.js';

function ref(
  contextKey: string,
  overrides: Partial<OutreachResolvedContextRefV1> = {},
): OutreachResolvedContextRefV1 {
  return {
    contextKey,
    locator: { source: 'government_record', category: 'hearing', id: contextKey },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
    title: `Source ${contextKey}`,
    summary: `Verified text for ${contextKey}`,
    clientId: null,
    verificationClass: 'authoritative',
    sensitivity: 'normal',
    instructionsAllowed: false,
    usableAsEvidence: true,
    usableAsWritingGuidance: false,
    sourceSnapshot: {
      system: 'test',
      version: '1',
      lastVerifiedAt: '2026-08-11T00:00:00.000Z',
    },
    snapshotHash: contextKey
      .padEnd(64, 'a')
      .slice(0, 64)
      .replace(/[^a-f0-9]/g, 'a'),
    ...overrides,
  } as OutreachResolvedContextRefV1;
}

describe('Outreach V3 generation context adapter', () => {
  it('turns reauthorized writing guidance into a directive, never evidence', () => {
    const guidance = ref('voice', {
      locator: {
        source: 'memory_item',
        id: '11111111-1111-4111-8111-111111111111',
        clientId: null,
      },
      contextClass: 'writing_guidance',
      verificationClass: 'first_party',
      usableAsEvidence: false,
      usableAsWritingGuidance: true,
      instructionsAllowed: true,
    });

    const prepared = prepareOutreachV3ContextForGeneration([guidance], [guidance]);
    expect(prepared.serverEvidence).toEqual([]);
    expect(prepared.selectedItems).toEqual([
      expect.objectContaining({
        id: 'v3-guidance:voice',
        kind: 'note',
        noteUse: 'instruction',
        customNoteText: guidance.summary,
      }),
    ]);
  });

  it('captures every factual V3 source as bounded server evidence from the current authorized snapshot', () => {
    const document = ref('document-a', {
      locator: {
        source: 'document',
        id: '22222222-2222-4222-8222-222222222222',
        clientId: null,
      },
      verificationClass: 'first_party',
    });
    const bill = ref('bill-a', {
      locator: { source: 'government_record', category: 'bill', id: '118-hr-1234' },
    });

    const prepared = prepareOutreachV3ContextForGeneration([document, bill], [document, bill]);
    expect(prepared.selectedItems).toEqual([]);
    expect(prepared.serverEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextKey: 'document-a',
          sourceType: 'outreach_v3:document',
          text: document.summary,
          trust: 'server_record',
        }),
        expect.objectContaining({
          contextKey: 'bill-a',
          sourceType: 'outreach_v3:government_record:bill',
          text: bill.summary,
          trust: 'authoritative_structured',
        }),
      ]),
    );
  });

  it('bounds factual text before both packet enrichment and ledger compilation', () => {
    const oversized = ref('large-fact', {
      summary: `  ${'x'.repeat(MAX_EVIDENCE_ITEM_CHARS + 500)}  `,
    });
    const prepared = prepareOutreachV3ContextForGeneration([oversized], [oversized]);
    const evidence = prepared.serverEvidence[0]!;
    expect(evidence.text.length).toBe(MAX_EVIDENCE_ITEM_CHARS);
    expect(evidence.text.endsWith('…')).toBe(true);
    expect(evidence.truncated).toBe(true);
  });

  it('preserves governed V3 source identity and trust', () => {
    const hearing = ref('hearing-a');
    const prepared = prepareOutreachV3ContextForGeneration([hearing], [hearing]);
    expect(prepared.selectedItems).toEqual([]);
    expect(prepared.serverEvidence).toEqual([
      expect.objectContaining({
        contextKey: 'hearing-a',
        sourceType: 'outreach_v3:government_record:hearing',
        sourceId: 'hearing-a',
        text: hearing.summary,
        trust: 'authoritative_structured',
        truncated: false,
      }),
    ]);
  });

  it('keeps manual target facts explicitly user-authored while using the same factual channel', () => {
    const manual = ref('manual-fact', {
      locator: {
        source: 'manual',
        id: '33333333-3333-4333-8333-333333333333',
        title: 'User supplied fact',
        text: 'The target asked us to follow up next week.',
        sourceLabel: 'Lobbyist note',
      },
      contextClass: 'target_specific',
      scope: { kind: 'target', targetKey: 'directory_member:alpha' },
      verificationClass: 'user_supplied',
      usableAsEvidence: false,
    });

    const prepared = prepareOutreachV3ContextForGeneration([manual], [manual]);
    expect(prepared.selectedItems).toEqual([]);
    expect(prepared.serverEvidence).toEqual([
      expect.objectContaining({
        contextKey: 'manual-fact',
        sourceType: 'outreach_v3:manual',
        text: manual.summary,
        trust: 'user_authored',
      }),
    ]);
  });

  it('fails closed when a selected source changed after review', () => {
    const selected = ref('fact-a');
    const current = ref('fact-a', { snapshotHash: 'f'.repeat(64) });
    expect(() => prepareOutreachV3ContextForGeneration([selected], [current])).toThrow(
      OutreachV3GenerationContextError,
    );
    try {
      prepareOutreachV3ContextForGeneration([selected], [current]);
    } catch (error) {
      expect((error as OutreachV3GenerationContextError).code).toBe('CONTEXT_SNAPSHOT_CHANGED');
    }
  });

  it('fails closed when factual context loses evidence authorization', () => {
    const selected = ref('fact-a');
    const current = ref('fact-a', {
      snapshotHash: selected.snapshotHash,
      usableAsEvidence: false,
      verificationClass: 'unverified',
    });
    let thrown: OutreachV3GenerationContextError | null = null;
    try {
      prepareOutreachV3ContextForGeneration([selected], [current]);
    } catch (error) {
      thrown = error as OutreachV3GenerationContextError;
    }
    expect(thrown?.code).toBe('CONTEXT_NOT_USABLE_AS_EVIDENCE');
  });
});
