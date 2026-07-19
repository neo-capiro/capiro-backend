import { MERI_TOOL_MANIFEST } from '@capiro/shared';
import { TOOL_DEFINITIONS } from './meri-tools.service.js';

/**
 * W4.6 / D-13 — apps/api is the SOURCE of the Meri tool surface. This pins that
 * TOOL_DEFINITIONS' name→description exactly equals the canonical
 * MERI_TOOL_MANIFEST checked into @capiro/shared. If someone edits a tool's
 * description (or adds/removes a tool) here, this fails until the manifest is
 * regenerated — which in turn fails the orchestrator's catalog-parity test until
 * the delegated catalogs are updated to match. That closes the loop the old
 * name-only coverage test left open (a description could drift undetected).
 */
describe('TOOL_DEFINITIONS ↔ MERI_TOOL_MANIFEST parity (W4.6 / D-13)', () => {
  const actual: Record<string, string> = {};
  for (const t of TOOL_DEFINITIONS) {
    actual[(t as { name: string }).name] = (t as { description: string }).description;
  }

  it('every apps/api tool name+description matches the canonical manifest exactly', () => {
    expect(actual).toEqual({ ...MERI_TOOL_MANIFEST });
  });

  it('the tool count is stable at 72 (manifest and TOOL_DEFINITIONS agree)', () => {
    expect(Object.keys(actual)).toHaveLength(72);
    expect(Object.keys(MERI_TOOL_MANIFEST)).toHaveLength(72);
  });
});
