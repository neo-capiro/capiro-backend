import { CONTEXT_PLANE_ENFORCEMENT_PHASE } from '@capiro/meriv2-core';
import {
  CONTEXT_PLANE_OPERATIONS,
  contextPlaneOperation,
} from './context-plane-operation-registry.js';

const PHASE19_ADOPTED = ['meri.chat', 'meri.research', 'research.generate-report'] as const;

describe('Knowledge Plane Context Plane operation registry', () => {
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

  test('Phase 19 Meri/research operations are packet-required and carry no migration debt', () => {
    for (const id of PHASE19_ADOPTED) {
      const entry = contextPlaneOperation(id);
      expect(entry?.registration.mode).toBe('packet_required');
      expect(entry?.registration.migrationException).toBeUndefined();
      expect(entry?.legacyPaths).toEqual([]);
    }
  });

  test('remaining legacy ownership is explicit, reviewed, phase-bounded, and tied to concrete implementation debt', () => {
    expect(CONTEXT_PLANE_ENFORCEMENT_PHASE).toBe(18);
    const remaining = CONTEXT_PLANE_OPERATIONS.filter(
      (entry) => entry.registration.mode === 'migration_exception',
    );
    expect(remaining.length).toBeGreaterThan(0);
    for (const entry of remaining) {
      const registration = entry.registration;
      expect(registration.id).not.toContain('*');
      expect(registration.migrationException).toEqual(
        expect.objectContaining({
          approvalBasis: 'knowledge-plane-phase-sequence',
        }),
      );
      expect(registration.migrationException!.targetPhase).toBeGreaterThan(19);
      expect(registration.migrationException!.targetPhase).toBeLessThanOrEqual(25);
      expect(entry.legacyPaths.length).toBeGreaterThan(0);
      expect(entry.legacyPaths.every((path) => path.trim().length > 0)).toBe(true);
    }
  });

  test('matches the remaining master-plan adoption sequence after Meri: Outreach 20, Workspace 21, LegiWatch 22, CRM 23, Meetings 24, Strategies 25', () => {
    const target = (id: string) =>
      contextPlaneOperation(id)?.registration.migrationException?.targetPhase;

    expect(contextPlaneOperation('meri.chat')?.registration.mode).toBe('packet_required');
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
