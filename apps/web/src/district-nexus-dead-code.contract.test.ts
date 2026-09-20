import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

function source(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8');
}

describe('District Nexus dead-code contract', () => {
  it('does not retain the superseded client-CRM prototype map', () => {
    expect(existsSync(resolve(SRC, 'vnext/pages/client-crm/DistrictNexusMap.tsx'))).toBe(false);
  });

  it('does not retain unused District Nexus exports', () => {
    expect(source('vnext/pages/district-nexus/icons.tsx')).not.toContain('DnxMapPinIcon');
    expect(source('pages/intelligence/district-nexus/district-nexus-api.ts')).not.toContain(
      'getClientDistrictStrategicMap',
    );
  });
});
