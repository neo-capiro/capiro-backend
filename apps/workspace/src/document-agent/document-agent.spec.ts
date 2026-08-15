// Document Agent spec — tests the core state machine, service, and controller
// behavior. The reasoning gateway is mocked; tests never call a live model.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  canTransition,
  transitionPhase,
  transitionStatus,
  mutateState,
} from './document-agent-state-machine.js';
import {
  createInitialAgentState,
  readAgentState,
  computeContextSnapshotHash,
  computeOutlineHash,
  computeContentHash,
  type DocumentAgentState,
  type DocumentAgentPhase,
} from './document-agent-state.js';

// ── State machine tests ─────────────────────────────────────────────────

describe('document-agent state machine', () => {
  describe('canTransition', () => {
    it('allows forward transitions in order', () => {
      expect(canTransition('type', 'blueprint')).toBe(true);
      expect(canTransition('blueprint', 'design')).toBe(true);
      expect(canTransition('design', 'goal')).toBe(true);
      expect(canTransition('goal', 'brief')).toBe(true);
      expect(canTransition('brief', 'context')).toBe(true);
      expect(canTransition('context', 'outline')).toBe(true);
      expect(canTransition('outline', 'generate')).toBe(true);
      expect(canTransition('generate', 'draft')).toBe(true);
      expect(canTransition('draft', 'quality')).toBe(true);
      expect(canTransition('quality', 'complete')).toBe(true);
    });

    it('allows backward transitions to reopenable phases', () => {
      expect(canTransition('context', 'brief')).toBe(true);
      expect(canTransition('outline', 'goal')).toBe(true);
      expect(canTransition('generate', 'brief')).toBe(true);
    });

    it('rejects invalid forward transitions (skipping phases)', () => {
      expect(canTransition('type', 'context')).toBe(false);
      expect(canTransition('blueprint', 'outline')).toBe(false);
      expect(canTransition('goal', 'generate')).toBe(false);
    });

    it('rejects transitions from complete to any phase', () => {
      expect(canTransition('complete', 'brief')).toBe(false);
      expect(canTransition('complete', 'generate')).toBe(false);
    });
  });

  describe('transitionPhase', () => {
    it('increments revision on transition', () => {
      const state = createInitialAgentState();
      const next = transitionPhase(state, 'blueprint');
      expect(next.phase).toBe('blueprint');
      expect(next.revision).toBe(state.revision + 1);
    });

    it('throws on invalid transition', () => {
      const state = createInitialAgentState();
      expect(() => transitionPhase(state, 'context')).toThrow(
        /Invalid phase transition/,
      );
    });
  });

  describe('transitionStatus', () => {
    it('increments revision', () => {
      const state = createInitialAgentState();
      const next = transitionStatus(state, 'needs_input');
      expect(next.status).toBe('needs_input');
      expect(next.revision).toBe(state.revision + 1);
    });
  });

  describe('mutateState', () => {
    it('applies mutation and increments revision', () => {
      const state = createInitialAgentState();
      const next = mutateState(state, (s) => {
        s.goal = { text: 'Test goal', createdAt: new Date().toISOString() };
      });
      expect(next.goal?.text).toBe('Test goal');
      expect(next.revision).toBe(state.revision + 1);
      // Original state is not mutated (immutability).
      expect(state.goal).toBeNull();
    });
  });
});

// ── State helpers tests ──────────────────────────────────────────────────

describe('document-agent state helpers', () => {
  describe('createInitialAgentState', () => {
    it('creates a state with schemaVersion 1 and revision 0', () => {
      const state = createInitialAgentState();
      expect(state.schemaVersion).toBe(1);
      expect(state.revision).toBe(0);
      expect(state.phase).toBe('type');
      expect(state.status).toBe('active');
      expect(state.documentType).toBeNull();
      expect(state.blueprintPin).toBeNull();
      expect(state.brief.assumptions).toEqual([]);
      expect(state.outline.sections).toEqual([]);
    });
  });

  describe('readAgentState', () => {
    it('returns initial state for null config', () => {
      const state = readAgentState(null);
      expect(state.revision).toBe(0);
    });

    it('returns initial state for config without documentAgent', () => {
      const state = readAgentState({ sections: [] });
      expect(state.revision).toBe(0);
    });

    it('reads existing agent state from config', () => {
      const initial = createInitialAgentState();
      initial.revision = 5;
      initial.phase = 'brief';
      const config = { documentAgent: initial };
      const state = readAgentState(config);
      expect(state.revision).toBe(5);
      expect(state.phase).toBe('brief');
    });
  });

  describe('computeContextSnapshotHash', () => {
    it('produces a deterministic hash for the same items', () => {
      const items = [
        { id: 'b', label: 'Item B', text: 'text b' },
        { id: 'a', label: 'Item A', text: 'text a' },
      ];
      const hash1 = computeContextSnapshotHash(items);
      const hash2 = computeContextSnapshotHash(items);
      expect(hash1).toBe(hash2);
    });

    it('produces a different hash for different items', () => {
      const items1 = [{ id: 'a', label: 'A', text: 'text a' }];
      const items2 = [{ id: 'a', label: 'A', text: 'text b' }];
      expect(computeContextSnapshotHash(items1)).not.toBe(
        computeContextSnapshotHash(items2),
      );
    });

    it('order-independent (sorts by id)', () => {
      const items1 = [
        { id: 'b', label: 'B', text: 'b' },
        { id: 'a', label: 'A', text: 'a' },
      ];
      const items2 = [
        { id: 'a', label: 'A', text: 'a' },
        { id: 'b', label: 'B', text: 'b' },
      ];
      expect(computeContextSnapshotHash(items1)).toBe(
        computeContextSnapshotHash(items2),
      );
    });
  });

  describe('computeOutlineHash', () => {
    it('produces a deterministic hash', () => {
      const sections = [
        { id: 's1', title: 'Intro', purpose: 'p', instructions: 'i', required: true, locked: false, targetWords: { min: 100, max: 200 }, evidenceItemIds: [] },
      ];
      expect(computeOutlineHash(sections)).toBe(computeOutlineHash(sections));
    });
  });

  describe('computeContentHash', () => {
    it('produces a deterministic hash', () => {
      const content = { s1: 'hello', s2: 'world' };
      expect(computeContentHash(content)).toBe(computeContentHash(content));
    });

    it('order-independent (sorts keys)', () => {
      const c1 = { s1: 'a', s2: 'b' };
      const c2 = { s2: 'b', s1: 'a' };
      expect(computeContentHash(c1)).toBe(computeContentHash(c2));
    });
  });
});

// ── Context conflict detection tests ─────────────────────────────────────

import { DocumentAgentContextService } from './document-agent-context.service.js';

describe('DocumentAgentContextService', () => {
  const service = new DocumentAgentContextService(
    { wsContextItem: { findMany: jest.fn() } } as never,
    {} as never,
  );

  describe('classify', () => {
    it('classifies government sources as primary', () => {
      const result = service.classify({ sourceType: 'government', id: '1' });
      expect(result.authority).toBe('primary');
    });

    it('classifies news as secondary', () => {
      const result = service.classify({ sourceType: 'news', id: '1' });
      expect(result.authority).toBe('secondary');
    });

    it('classifies freshness based on publishedAt', () => {
      const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const result = service.classify({ sourceType: 'government', publishedAt: recent });
      expect(result.freshness).toBe('current');
    });

    it('classifies old items as stale', () => {
      const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      const result = service.classify({ sourceType: 'news', publishedAt: old });
      expect(result.freshness).toBe('stale');
    });
  });

  describe('detectConflicts', () => {
    it('detects numeric conflicts', () => {
      const items = [
        { id: 'a', payload: { label: 'Funding', numericValue: 100 } },
        { id: 'b', payload: { label: 'Funding', numericValue: 200 } },
      ];
      const conflicts = service.detectConflicts(items);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe('numeric');
    });

    it('detects date conflicts', () => {
      const items = [
        { id: 'a', payload: { event: 'Hearing', date: '2026-09-01' } },
        { id: 'b', payload: { event: 'Hearing', date: '2026-09-15' } },
      ];
      const conflicts = service.detectConflicts(items);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe('date');
    });

    it('detects status conflicts', () => {
      const items = [
        { id: 'a', payload: { subject: 'Bill', status: 'passed' } },
        { id: 'b', payload: { subject: 'Bill', status: 'pending' } },
      ];
      const conflicts = service.detectConflicts(items);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.type).toBe('status');
    });

    it('returns empty for no conflicts', () => {
      const items = [
        { id: 'a', payload: { label: 'A', numericValue: 100 } },
        { id: 'b', payload: { label: 'B', numericValue: 200 } },
      ];
      const conflicts = service.detectConflicts(items);
      expect(conflicts).toHaveLength(0);
    });
  });
});

// ── Outline service tests ────────────────────────────────────────────────

import { DocumentAgentOutlineService } from './document-agent-outline.service.js';

describe('DocumentAgentOutlineService', () => {
  const service = new DocumentAgentOutlineService(
    { wsBlueprintVersion: { findFirst: jest.fn() } } as never,
    {} as never,
  );

  describe('validateAgainstBlueprint', () => {
    it('passes when all required sections present', () => {
      const sections = [
        { id: 's1', title: 'Intro', purpose: 'p', instructions: 'i', required: true, locked: true, targetWords: { min: 100, max: 200 }, evidenceItemIds: [] },
      ];
      const blueprintSections = [{ id: 's1', title: 'Intro', required: true, lockedByDefault: true }];
      const result = service.validateAgainstBlueprint(sections, blueprintSections);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when required section missing', () => {
      const sections: never[] = [];
      const blueprintSections = [{ id: 's1', title: 'Intro', required: true, lockedByDefault: false }];
      const result = service.validateAgainstBlueprint(sections, blueprintSections);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!).toContain('Required section');
    });

    it('fails when locked section is unlocked', () => {
      const sections = [
        { id: 's1', title: 'Intro', purpose: 'p', instructions: 'i', required: true, locked: false, targetWords: { min: 100, max: 200 }, evidenceItemIds: [] },
      ];
      const blueprintSections = [{ id: 's1', title: 'Intro', required: true, lockedByDefault: true }];
      const result = service.validateAgainstBlueprint(sections, blueprintSections);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!).toContain('Locked section');
    });
  });
});

// ── Revision service tests ──────────────────────────────────────────────

import { DocumentAgentRevisionService } from './document-agent-revision.service.js';

describe('DocumentAgentRevisionService', () => {
  it('creates a proposal', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'prop-1' } as never);
    const service = new DocumentAgentRevisionService({
      wsAgentProposal: { create },
    } as never);
    const result = await service.createProposal({
      tenantId: 't1',
      draftId: 'd1',
      createdById: 'u1',
      type: 'outline_revision',
      baseRevision: 1,
      baseHash: 'hash',
      payload: { instruction: 'fix' },
    });
    expect(result.proposalId).toBe('prop-1');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('detects stale proposals by hash mismatch', () => {
    const service = new DocumentAgentRevisionService({} as never);
    expect(service.verifyNotStale('hash-a', 'hash-b')).toBe(false);
    expect(service.verifyNotStale('hash-a', 'hash-a')).toBe(true);
  });
});
