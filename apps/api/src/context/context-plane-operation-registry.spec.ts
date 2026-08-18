import { CONTEXT_PLANE_ENFORCEMENT_PHASE } from '@capiro/meriv2-core';
import {
  CONTEXT_PLANE_OPERATIONS,
  contextPlaneOperation,
} from './context-plane-operation-registry.js';

describe('Knowledge Plane Phase 18 operation registry', () => {
  test('covers every product family named by the Phase 18 audit', () => {
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
    expect(contextPlaneOperation('research.generate-report')).toBeDefined();
  });

  test('current legacy ownership is explicit, reviewed, phase-bounded, and tied to concrete implementation debt', () => {
    expect(CONTEXT_PLANE_ENFORCEMENT_PHASE).toBe(18);
    for (const entry of CONTEXT_PLANE_OPERATIONS) {
      const registration = entry.registration;
      expect(registration.mode).toBe('migration_exception');
      expect(registration.id).not.toContain('*');
      expect(registration.migrationException).toEqual(
        expect.objectContaining({
          approvalBasis: 'knowledge-plane-phase-sequence',
        }),
      );
      expect(registration.migrationException!.targetPhase).toBeGreaterThan(18);
      expect(registration.migrationException!.targetPhase).toBeLessThanOrEqual(25);
      expect(entry.legacyPaths.length).toBeGreaterThan(0);
      expect(entry.legacyPaths.every((path) => path.trim().length > 0)).toBe(true);
    }
  });

  test('matches the master-plan adoption sequence: Meri 19, Outreach 20, Workspace 21, LegiWatch 22, CRM 23, Meetings 24, Strategies 25', () => {
    const target = (id: string) =>
      contextPlaneOperation(id)?.registration.migrationException?.targetPhase;

    expect(target('meri.chat')).toBe(19);
    expect(target('outreach.generate')).toBe(20);
    expect(target('workspace.generate')).toBe(21);
    expect(target('legiwatch.generate-report')).toBe(22);
    expect(target('crm.fill-with-meri')).toBe(23);
    expect(target('meetings.prep-debrief')).toBe(24);
    expect(target('strategies.generate')).toBe(25);
  });

  test('operation ids are unique and no catch-all registration exists', () => {
    const ids = CONTEXT_PLANE_OPERATIONS.map((entry) => entry.registration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('all');
    expect(ids).not.toContain('future.*');
    expect(ids.every((id) => !id.includes('*'))).toBe(true);
  });
});
