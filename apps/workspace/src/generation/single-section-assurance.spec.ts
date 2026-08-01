import { ServiceUnavailableException } from '@nestjs/common';
import type { GenerateSectionResult } from './generation.service.js';
import { runWithGenerationAssuranceTenant } from './generation-assurance.js';
import { assertSingleGeneratedSectionRelease } from './single-section-assurance.js';

const TENANT = 'tenant-a';

function result(content: string): GenerateSectionResult {
  return {
    section: 'Funding',
    content,
    provider: 'anthropic',
    model: 'test-model',
    usedTenantKey: false,
    anonymized: false,
    provenance: {
      generatedAt: '2026-08-01T00:00:00.000Z',
      contextItems: [],
      memoryFiles: [],
      linkedPeCodes: [],
      contextPacketId: null,
      contextTraceHash: null,
      contextDegraded: false,
      provider: 'anthropic',
      model: 'test-model',
      credentialSource: 'platform',
    },
    citations: [],
    invalidCitations: [],
  };
}

function withReleaseGate<T>(
  mode: 'off' | 'shadow' | 'enforce',
  tenant: string,
  surfaces: string,
  work: () => T,
): T {
  const before = {
    mode: process.env.MERI_RELEASE_GATE,
    tenants: process.env.MERI_RELEASE_GATE_TENANTS,
    surfaces: process.env.MERI_RELEASE_GATE_SURFACES,
  };
  process.env.MERI_RELEASE_GATE = mode;
  process.env.MERI_RELEASE_GATE_TENANTS = tenant;
  process.env.MERI_RELEASE_GATE_SURFACES = surfaces;
  try {
    return work();
  } finally {
    restore('MERI_RELEASE_GATE', before.mode);
    restore('MERI_RELEASE_GATE_TENANTS', before.tenants);
    restore('MERI_RELEASE_GATE_SURFACES', before.surfaces);
  }
}

describe('standalone Workspace section assurance', () => {
  it('holds an unsupported high-risk section for the selected tenant and surface', () => {
    expect(() =>
      withReleaseGate('enforce', TENANT, 'workspace-gen', () =>
        runWithGenerationAssuranceTenant(TENANT, () =>
          assertSingleGeneratedSectionRelease(
            result('<p>The FY27 request is $412.5 million and increased by 22 percent.</p>'),
          ),
        ),
      ),
    ).toThrow(ServiceUnavailableException);
  });

  it('computes shadow evidence without changing the returned section', () => {
    const summary = withReleaseGate('shadow', TENANT, 'workspace-gen', () =>
      runWithGenerationAssuranceTenant(TENANT, () =>
        assertSingleGeneratedSectionRelease(
          result('<p>The FY27 request is $412.5 million and increased by 22 percent.</p>'),
        ),
      ),
    );
    expect(summary.held).toBe(true);
    expect(summary.blockerCount).toBeGreaterThan(0);
  });

  it('does not let another tenant canary hold this request', () => {
    expect(() =>
      withReleaseGate('enforce', 'tenant-b', 'workspace-gen', () =>
        runWithGenerationAssuranceTenant(TENANT, () =>
          assertSingleGeneratedSectionRelease(
            result('<p>The FY27 request is $412.5 million and increased by 22 percent.</p>'),
          ),
        ),
      ),
    ).not.toThrow();
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
