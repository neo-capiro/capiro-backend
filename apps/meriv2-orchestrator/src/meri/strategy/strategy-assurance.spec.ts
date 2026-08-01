import { verifyAssuranceEnvelope } from '@capiro/meriv2-core';
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
  it('reports blockers and a valid envelope but never holds in shadow', () => {
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
      mode: 'shadow',
      contextPacketId: 'packet-1',
    });
    expect(out.held).toBe(false);
    expect(out.blockers.length).toBeGreaterThan(0);
    expect(out.unresolvedProvenanceSections).toEqual(['Background']);
    expect(out.envelope.contextPacketId).toBe('packet-1');
    expect(verifyAssuranceEnvelope(out.envelope).valid).toBe(true);
  });

  it('flags provenance citing a section the context pack did NOT load', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section({ sources: [{ section: 'Knowledge graph (walled)' }] })],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      mode: 'enforce',
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
      mode: 'enforce',
    });
    expect(out.unresolvedProvenanceSections).toEqual(['Background']);
  });

  it('holds an outreach_record on degraded context health only in enforce mode', () => {
    const args = {
      sections: [section()],
      provenance,
      health: { status: 'degraded' as const, missingRequired: ['Client profile'], omittedOptional: [] },
      kind: 'outreach_record' as const,
    };
    expect(assessStrategyDocumentClaims({ ...args, mode: 'shadow' }).held).toBe(false);
    const out = assessStrategyDocumentClaims({ ...args, mode: 'enforce' });
    expect(out.held).toBe(true);
    expect(out.blockers.some((b) => /verification was unavailable/i.test(b))).toBe(true);
    expect(out.envelope.surface).toBe('outreach');
  });

  it('does not flag provenance that resolves to a loaded pack section', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section(), section({ heading: 'Recommendation' })],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      mode: 'enforce',
    });
    expect(out.unresolvedProvenanceSections).toEqual([]);
  });

  it('binds policy and Context Packet drift inputs into the envelope', () => {
    const out = assessStrategyDocumentClaims({
      sections: [section()],
      provenance,
      health: healthy,
      kind: 'workspace_draft',
      mode: 'shadow',
      contextPacketId: 'packet-9',
      policyBinding: {
        packId: 'pack-a',
        packVersion: '7',
        ruleId: 'strategy-release',
        decisionHash: 'decision-hash',
      },
    });
    expect(out.envelope.policyBinding).toMatchObject({ packId: 'pack-a', packVersion: '7' });
    expect(
      verifyAssuranceEnvelope(out.envelope, {
        contextPacketId: 'packet-10',
        policyBinding: { packId: 'pack-a', packVersion: '8', ruleId: 'strategy-release' },
      }).errors,
    ).toEqual(expect.arrayContaining(['context_packet_drift', 'policy_binding_drift']));
  });

  it('is deterministic at the claim-ledger boundary', () => {
    const args = {
      sections: [section()],
      provenance,
      health: healthy,
      kind: 'workspace_draft' as const,
      mode: 'enforce' as const,
    };
    expect(assessStrategyDocumentClaims(args).ledgerHash).toBe(
      assessStrategyDocumentClaims(args).ledgerHash,
    );
  });
});
