import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('vNext Client CRM District Nexus contract', () => {
  it('does not call the legacy district-nexus-spend client', () => {
    const intelligence = readFileSync(resolve(__dirname, 'tabs/IntelligenceTab.tsx'), 'utf8');
    const refresh = readFileSync(resolve(__dirname, 'client-intelligence-refresh.ts'), 'utf8');

    expect(intelligence).not.toContain('getClientDistrictNexus(');
    expect(refresh).not.toContain('getClientDistrictNexus(');
  });
});
