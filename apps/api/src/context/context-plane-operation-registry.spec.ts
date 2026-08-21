import { CONTEXT_PLANE_ENFORCEMENT_PHASE } from '@capiro/meriv2-core';
import {
  CONTEXT_PLANE_OPERATIONS,
  contextPlaneOperation,
} from './context-plane-operation-registry.js';

const ADOPTED_BY_PHASE = [
  ['Phase 19', ['meri.chat', 'meri.research', 'research.generate-report']],
  ['Phase 20', ['outreach.generate']],
  ['Phase 21', ['workspace.generate', 'workspace.editor-assist']],
  ['Phase 22', ['legiwatch.generate-report']],
  ['Phase 23', ['crm.fill-with-meri']],
  ['Phase 24', ['meetings.prep-debrief']],
  ['Phase 25', ['strategies.generate']],
] as const;

describe('Knowledge Plane Context Plane operation registry', () => {
  test('covers every product family named by the adoption audit', () => {
    const products = new Set(CONTEXT_PLANE_OPERATIONS.map((entry) => entry.registration.product));
    for (const required of [
      'meri',
      'workspace',
      'outreach',
      'legiwatch',
      'crm',
      'meetings',
      'strategies',
      'research',
    ]) {
      expect(products.has(required)).toBe(true);
    }
  });

  test.each(ADOPTED_BY_PHASE)(
    '%s adopted operations are packet-required and carry no migration debt',
    (_phase, ids) => {
      for (const id of ids) {
        const entry = contextPlaneOperation(id);
        expect(entry?.registration.mode).toBe('packet_required');
        expect(entry?.registration.migrationException).toBeUndefined();
      }
    },
  );

  test('Phase 26 starts with zero reviewed migration exceptions', () => {
    expect(CONTEXT_PLANE_ENFORCEMENT_PHASE).toBe(18);
    const remaining = CONTEXT_PLANE_OPERATIONS.filter(
      (entry) => entry.registration.mode === 'migration_exception',
    );
    expect(remaining).toEqual([]);
    expect(
      CONTEXT_PLANE_OPERATIONS.every(
        (entry) => entry.registration.mode === 'packet_required',
      ),
    ).toBe(true);
  });

  test('operation ids are unique and no catch-all registration exists', () => {
    const ids = CONTEXT_PLANE_OPERATIONS.map((entry) => entry.registration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('all');
    expect(ids).not.toContain('future.*');
    expect(ids.every((id) => !id.includes('*'))).toBe(true);
  });
});
