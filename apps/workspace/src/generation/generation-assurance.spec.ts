import { verifyAssuranceEnvelope } from '@capiro/meriv2-core/assurance/generation';
import {
  assessGeneratedSectionsForRelease,
  generationAssuranceRolloutMode,
  generationClaimHoldEnforced,
  runWithGenerationAssuranceTenant,
} from './generation-assurance';
import type { SectionCitation } from './citations';

describe('Phase 16 Workspace assurance rollout', () => {
  it('is OFF when any of the three required controls is absent', () => {
    expect(generationClaimHoldEnforced('workspace-gen', undefined, 'all')).toBe(false);
    expect(generationClaimHoldEnforced('workspace-gen', 'enforce', undefined)).toBe(false);
    expect(generationClaimHoldEnforced(undefined, 'enforce', 'all')).toBe(false);
  });

  it('legacy no-tenant call can enforce only through an explicit all-tenant canary', () => {
    expect(generationClaimHoldEnforced('workspace-gen', 'enforce', 'all')).toBe(true);
    expect(generationClaimHoldEnforced('all', 'enforce', 'all')).toBe(true);
    expect(generationClaimHoldEnforced('workspace-gen', 'shadow', 'all')).toBe(false);
    expect(generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-a')).toBe(false);
  });

  it('supports an exact tenant shadow/enforce canary at tenant-aware call sites', () => {
    expect(generationAssuranceRolloutMode('tenant-a', 'shadow', 'tenant-a', 'workspace-gen')).toBe(
      'shadow',
    );
    expect(generationAssuranceRolloutMode('tenant-a', 'enforce', 'tenant-a', 'workspace-gen')).toBe(
      'enforce',
    );
    expect(generationAssuranceRolloutMode('tenant-b', 'enforce', 'tenant-a', 'workspace-gen')).toBe(
      'off',
    );
  });

  it('binds the inherited no-argument hold helper to the authenticated request tenant', async () => {
    await runWithGenerationAssuranceTenant('tenant-a', async () => {
      await Promise.resolve();
      expect(generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-a')).toBe(true);
      expect(generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-b')).toBe(false);
    });
    await runWithGenerationAssuranceTenant('tenant-b', async () => {
      await Promise.resolve();
      expect(generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-a')).toBe(false);
    });
  });

  it('isolates concurrent request tenants without process-global mutation', async () => {
    const [tenantA, tenantB] = await Promise.all([
      runWithGenerationAssuranceTenant('tenant-a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-a');
      }),
      runWithGenerationAssuranceTenant('tenant-b', async () => {
        await Promise.resolve();
        return generationClaimHoldEnforced('workspace-gen', 'enforce', 'tenant-a');
      }),
    ]);
    expect(tenantA).toBe(true);
    expect(tenantB).toBe(false);
  });

  it('fails safe on near-miss or truthy-looking values', () => {
    for (const raw of ['workspacegen', 'workspace_gen', 'true', 'on', '1', 'yes']) {
      expect(generationClaimHoldEnforced(raw, 'enforce', 'all')).toBe(false);
    }
  });
});

describe('assessGeneratedSectionsForRelease', () => {
  const budgetCitation: SectionCitation[] = [
    { n: 1, token: '[S:pe:0604270F]', kind: 'pe', refId: '0604270F', label: 'PE 0604270F' },
  ];

  it('keeps locator-only evidence unbound across tenant-controlled off/shadow/enforce modes', () => {
    const previous = {
      mode: process.env.MERI_EVIDENCE_PROFILES_MODE,
      tenants: process.env.MERI_EVIDENCE_PROFILES_TENANTS,
      surfaces: process.env.MERI_EVIDENCE_PROFILES_SURFACES,
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const tenant = '11111111-1111-4111-8111-111111111111';
    const args = {
      generated: [
        { section: 'Client', html: '<p>The client record is current.<sup>[1]</sup></p>' },
      ],
      sectionCitations: {
        Client: [
          {
            n: 1,
            token: '[S:client:1]',
            kind: 'ctx' as const,
            refId: 'client-1',
            label: 'Client record',
          },
        ],
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    try {
      process.env.MERI_EVIDENCE_PROFILES_TENANTS = tenant;
      process.env.MERI_EVIDENCE_PROFILES_SURFACES = 'workspace-gen';
      process.env.MERI_EVIDENCE_PROFILES_MODE = 'off';
      const off = runWithGenerationAssuranceTenant(tenant, () =>
        assessGeneratedSectionsForRelease(args),
      );
      expect(log).not.toHaveBeenCalled();
      expect(off.verdicts[0]?.envelope.claimLedger.evidence[0]).toMatchObject({
        sourceId: 'client-1',
        ownerVerified: false,
        primary: false,
        authoritative: false,
      });

      process.env.MERI_EVIDENCE_PROFILES_MODE = 'shadow';
      const shadow = runWithGenerationAssuranceTenant(tenant, () =>
        assessGeneratedSectionsForRelease(args),
      );
      expect(shadow.heldSections).toEqual(off.heldSections);
      expect(shadow.verdicts[0]?.envelope.claimLedger.evidence[0]).toMatchObject({
        sourceId: 'client-1',
        ownerVerified: false,
        primary: false,
        authoritative: false,
      });
      expect(
        shadow.verdicts.map(({ decision, held, blockers, riskLevel }) => ({
          decision,
          held,
          blockers,
          riskLevel,
        })),
      ).toEqual(
        off.verdicts.map(({ decision, held, blockers, riskLevel }) => ({
          decision,
          held,
          blockers,
          riskLevel,
        })),
      );
      expect(log).toHaveBeenCalledTimes(1);
      const event = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(event).toMatchObject({
        event: 'meri.evidence_profiles.shadow',
        surface: 'workspace-gen',
        callSite: 'assessGeneratedSectionsForRelease',
        evidenceItems: 1,
      });
      expect(JSON.stringify(event)).not.toContain('The client record is current');

      process.env.MERI_EVIDENCE_PROFILES_MODE = 'enforce';
      const enforce = runWithGenerationAssuranceTenant(tenant, () =>
        assessGeneratedSectionsForRelease(args),
      );
      expect(enforce.verdicts[0]?.envelope.claimLedger.evidence[0]).toMatchObject({
        sourceId: 'client-1',
        ownerVerified: false,
        primary: false,
        authoritative: false,
      });
    } finally {
      if (previous.mode === undefined) delete process.env.MERI_EVIDENCE_PROFILES_MODE;
      else process.env.MERI_EVIDENCE_PROFILES_MODE = previous.mode;
      if (previous.tenants === undefined) delete process.env.MERI_EVIDENCE_PROFILES_TENANTS;
      else process.env.MERI_EVIDENCE_PROFILES_TENANTS = previous.tenants;
      if (previous.surfaces === undefined) delete process.env.MERI_EVIDENCE_PROFILES_SURFACES;
      else process.env.MERI_EVIDENCE_PROFILES_SURFACES = previous.surfaces;
      log.mockRestore();
    }
  });

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
    expect(verifyAssuranceEnvelope(out.verdicts[0]!.envelope).valid).toBe(true);
  });

  it('judges each section separately so one unsupported section cannot fail siblings', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [
        {
          section: 'Funding',
          html: '<p>PE 0604270F received $412.5 million in the FY27 request.</p>',
        },
        { section: 'Cover', html: '<p>Prepared for the client leadership team.</p>' },
      ],
      sectionCitations: { Funding: [] },
    });
    expect(out.heldSections).toEqual(['Funding']);
    expect(out.verdicts.find((v) => v.section === 'Cover')?.held).toBe(false);
  });

  it('attributes a deterministic finding to the section containing its span', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [
        {
          section: 'Funding',
          html: '<p>The FY27 request fell from $200 million to $300 million.</p>',
        },
        { section: 'Background', html: '<p>The program supports autonomous systems.</p>' },
      ],
      groundingFindings: [
        {
          check: 'D4',
          severity: 'critical',
          span: 'The FY27 request fell from $200 million to $300 million.',
          detail: 'Funding direction is reversed.',
        },
      ],
    });
    expect(out.heldSections).toContain('Funding');
    expect(out.verdicts.find((v) => v.section === 'Background')?.envelope.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'D4' })]),
    );
    expect(
      out.verdicts
        .find((v) => v.section === 'Funding')
        ?.envelope.findings.find((finding) => finding.check === 'D4')?.attribution,
    ).toEqual({ scope: 'section', subjectId: 'Funding' });
  });

  it('retains a genuinely un-attributable critical finding as run-wide', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [{ section: 'Cover', html: '<p>Prepared for leadership.</p>' }],
      groundingFindings: [
        { check: 'D4', severity: 'critical', span: 'x', detail: 'run-wide verifier failure' },
      ],
    });
    expect(out.heldSections).toEqual(['Cover']);
    expect(out.verdicts[0]?.envelope.findings[0]?.attribution).toEqual({ scope: 'run' });
  });

  it('treats an empty section as nothing to hold', () => {
    const out = assessGeneratedSectionsForRelease({
      generated: [{ section: 'Ask', html: '   ' }],
    });
    expect(out.heldSections).toEqual([]);
    expect(out.verdicts[0]?.held).toBe(false);
    expect(out.verdicts[0]?.blockers).toEqual([]);
    // The empty output is not held, but its unspecified operating frame still
    // requires review. Do not turn that honest flag into a clean delivery.
    expect(out.verdicts[0]?.envelope.evidencePlan.incomplete).toBe(true);
    expect(out.verdicts[0]?.decision).toBe('deliver_with_flags');
  });

  it('a locator-only PE citation cannot gain authority or clear a budget-claim hold', () => {
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
    expect(withCitation.verdicts[0]?.envelope.claimLedger.evidence[0]).toMatchObject({
      sourceId: '0604270F',
      ownerVerified: false,
      primary: false,
      authoritative: false,
    });
    expect(withCitation.heldSections).toEqual(['Funding']);
    expect(withoutCitation.heldSections).toEqual(['Funding']);
    expect(withCitation.verdicts[0]?.decision).toBe('hold');
    expect(withCitation.verdicts[0]?.blockers).toEqual(withoutCitation.verdicts[0]?.blockers);
    expect(withCitation.verdicts[0]?.blockers).toEqual(
      expect.arrayContaining([
        'Unsupported high-risk claims: sentence-1.',
        'Missing required evidence: budget-amount.official, surface.high-risk-primary-basis.',
      ]),
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
});
