import {
  assessGeneratedSectionsForRelease,
  generationClaimHoldEnforced,
} from './generation-assurance';
import type { SectionCitation } from './citations';

/**
 * The switch test is the important one. A Phase 4 gate previously shipped ARMED
 * and unflagged and silently replaced real answers with refusals; this pins that
 * deploying this code, with no environment change, withholds nothing.
 */
describe('generationClaimHoldEnforced', () => {
  it('is OFF when unset — deploying must never arm the hold by itself', () => {
    for (const raw of [undefined, '', '   ', ',', ' , ']) {
      expect(generationClaimHoldEnforced(raw)).toBe(false);
    }
  });

  it('does NOT inherit MERI_RELEASE_GATE=enforce — that arms chat and api-strategy', () => {
    // A third service must not start withholding because someone armed the canary
    // on the first two.
    expect(generationClaimHoldEnforced('enforce')).toBe(false);
  });

  it('arms only on an explicit workspace-gen or all token', () => {
    expect(generationClaimHoldEnforced('workspace-gen')).toBe(true);
    expect(generationClaimHoldEnforced('in-editor,workspace-gen')).toBe(true);
    expect(generationClaimHoldEnforced(' WORKSPACE-GEN ')).toBe(true);
    expect(generationClaimHoldEnforced('all')).toBe(true);
  });

  it('fails safe on near-miss or truthy-looking values rather than guessing', () => {
    for (const raw of ['workspacegen', 'workspace_gen', 'true', 'on', '1', 'yes', 'workspace']) {
      expect(generationClaimHoldEnforced(raw)).toBe(false);
    }
  });

  it('reads MERI_RELEASE_GATE_SURFACES by default, and that variable is unset in CI', () => {
    // Belt and braces: the zero-argument form is what the service actually calls.
    expect(generationClaimHoldEnforced()).toBe(
      process.env.MERI_RELEASE_GATE_SURFACES
        ? generationClaimHoldEnforced(process.env.MERI_RELEASE_GATE_SURFACES)
        : false,
    );
  });
});

describe('assessGeneratedSectionsForRelease', () => {
  const budgetCitation: SectionCitation[] = [
    { n: 1, token: '[S:pe:0604270F]', kind: 'pe', refId: '0604270F', label: 'PE 0604270F' },
  ];

  it('holds a high-risk budget claim with NO citation at all', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [
        {
          section: 'Funding',
          html: '<p>PE 0604270F received $412.5 million in the FY27 request, a 22% increase.</p>',
        },
      ],
    });
    expect(out.heldSections).toEqual(['Funding']);
    expect(out.verdicts[0]?.riskLevel).toBe('high');
    expect(out.verdicts[0]?.blockers.length).toBeGreaterThan(0);
  });

  it('judges each section SEPARATELY so one bad section cannot fail the good ones', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [
        {
          section: 'Funding',
          html: '<p>PE 0604270F received $412.5 million in the FY27 request.</p>',
        },
        // No factual high-risk claim: nothing to hold.
        { section: 'Cover', html: '<p>Prepared for the client leadership team.</p>' },
      ],
      sectionCitations: { Funding: [] },
    });
    expect(out.heldSections).toEqual(['Funding']);
    expect(out.verdicts.find((v) => v.section === 'Cover')?.held).toBe(false);
  });

  it('treats an empty section as nothing to hold', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [{ section: 'Ask', html: '   ' }],
    });
    expect(out.heldSections).toEqual([]);
    expect(out.verdicts[0]?.decision).toBe('deliver');
  });

  it('a resolving [n] citation to an authoritative PE record supports the claim', () => {
    // applyCitations rewrites [S:pe:CODE] to <sup>[1]</sup>, so a persisted section
    // carries FORM A markers — the same shape the chat surface resolves.
    const withCitation = assessGeneratedSectionsForRelease({
      generated: [
        { section: 'Funding', html: '<p>The FY27 request is $412.5 million.<sup>[1]</sup></p>' },
      ],
      sectionCitations: { Funding: budgetCitation },
    });
    const withoutCitation = assessGeneratedSectionsForRelease({
      generated: [{ section: 'Funding', html: '<p>The FY27 request is $412.5 million.</p>' }],
      sectionCitations: { Funding: [] },
    });
    // The citation must make a real difference to the blocker set — otherwise the
    // gate is not reading provenance at all.
    expect(withCitation.verdicts[0]?.blockers).not.toEqual(withoutCitation.verdicts[0]?.blockers);
    expect(withoutCitation.verdicts[0]?.blockers.length).toBeGreaterThan(
      withCitation.verdicts[0]?.blockers.length ?? 0,
    );
  });

  it('an unavailable PE resolve is NOT treated as a clean structural pass', () => {
    const args = {
      generated: [
        { section: 'Funding', html: '<p>The FY27 request is $412.5 million.<sup>[1]</sup></p>' },
      ],
      sectionCitations: { Funding: budgetCitation },
    };
    const available = assessGeneratedSectionsForRelease({ ...args, peEvidenceAvailable: true });
    const unavailable = assessGeneratedSectionsForRelease({ ...args, peEvidenceAvailable: false });
    expect(unavailable.verdicts[0]?.blockers).toContain(
      'Required pre-release verification was unavailable.',
    );
    expect(available.verdicts[0]?.blockers).not.toContain(
      'Required pre-release verification was unavailable.',
    );
  });

  it('folds a run-level CRITICAL grounding finding into every section decision', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [{ section: 'Cover', html: '<p>Prepared for the client leadership team.</p>' }],
      groundingFindings: [
        { check: 'D4', severity: 'critical', span: 'x', detail: 'funding direction reversed' },
      ],
    });
    expect(out.heldSections).toEqual(['Cover']);
  });
});
