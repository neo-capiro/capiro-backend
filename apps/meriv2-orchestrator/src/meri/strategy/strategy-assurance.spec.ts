import { assessStrategyDocumentClaims } from './strategy-assurance';
import type { PackHealth, PackProvenance } from './strategy-context-pack.service';
import type { DocumentDraftSection } from './strategy-prompt';

const provenance: PackProvenance = {
  sections: [
    { name: 'Client Context Pack', count: 6 },
    { name: 'Client context facts (Steward)', count: 12 },
    { name: 'Empty section', count: 0 },
  ],
  omitted: ['Knowledge graph (walled)'],
};

const healthy: PackHealth = { status: 'ok', missingRequired: [], omittedOptional: [] };

function section(over: Partial<DocumentDraftSection> = {}): DocumentDraftSection {
  return {
    heading: 'Background',
    html: '<p>The client is headquartered in Arlington, Virginia.</p>',
    sources: [{ section: 'Client Context Pack' }],
    ...over,
  };
}

describe('assessStrategyDocumentClaims', () => {
  it('reports blockers but NEVER holds when not armed', () => {
    const out = assessStrategyDocumentClaims({
      sections: [
        section({
          html: '<p>PE 0604270F received $412.5 million in FY27.</p>',
          sources: [{ section: 'Knowledge graph (walled)' }],
        }),
      ],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      armed: false,
    });
    expect(out.held).toBe(false);
    // …but the problem IS observable before arming.
    expect(out.blockers.length).toBeGreaterThan(0);
    expect(out.unresolvedProvenanceSections).toEqual(['Background']);
  });

  it('flags provenance citing a section the context pack did NOT load', () => {
    // `omitted` sections were never shown to the model, so citing one is a
    // fabricated provenance entry — exactly what the structural check waves
    // through, since the entry is non-empty.
    const out = assessStrategyDocumentClaims({
      sections: [section({ sources: [{ section: 'Knowledge graph (walled)' }] })],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      armed: true,
    });
    expect(out.held).toBe(true);
    expect(out.unresolvedProvenanceSections).toEqual(['Background']);
    expect(out.blockers.some((b) => /did not load/.test(b))).toBe(true);
  });

  it('treats a zero-count pack section as not loaded', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section({ sources: [{ section: 'Empty section' }] })],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      armed: true,
    });
    expect(out.unresolvedProvenanceSections).toEqual(['Background']);
  });

  it('holds an outreach_record on degraded context health', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section()],
      provenance,
      health: { status: 'degraded', missingRequired: ['Client profile'], omittedOptional: [] },
      kind: 'outreach_record',
      armed: true,
    });
    expect(out.held).toBe(true);
    expect(out.blockers.some((b) => /verification was unavailable/i.test(b))).toBe(true);
  });

  it('does not flag provenance that resolves to a loaded pack section', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section(), section({ heading: 'Recommendation' })],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      armed: true,
    });
    expect(out.unresolvedProvenanceSections).toEqual([]);
  });

  it('is deterministic — the same draft hashes to the same ledger', () => {
    const args = {
      sections: [section()],
      provenance,
      health: healthy,
      kind: 'workspace_draft' as const,
      armed: true,
    };
    expect(assessStrategyDocumentClaims(args).ledgerHash).toBe(
      assessStrategyDocumentClaims(args).ledgerHash,
    );
  });
});
